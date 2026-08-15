#!/usr/bin/env node
// Builds the Accountant24 plugin index (marketplace.json) from GitHub.
//
// A plugin is listed when a public, non-fork, non-archived repository carries
// the topic `accountant24-plugin` and its default branch holds a valid
// plugin.json at the root. blocklist.json is hand-maintained and always wins.
//
// The index is rebuilt from scratch on every run: nothing is cached and nothing
// is retried. The workflow runs every 30 minutes and commits only when the file
// changed, so a run that fails costs nothing and the next one starts over.
//
// Zero dependencies, Node 22. Runs in GitHub Actions with the workflow's
// GITHUB_TOKEN. Locally: GITHUB_TOKEN=$(gh auth token) node scripts/index.mjs
//
// Flags:
//   --repo owner/name   index just this repository, print the result, and write
//                       nothing (skips the topic search; for authors checking
//                       their own repository before adding the topic)
//
// The desktop app validates every manifest again at install time, so this
// script checks only what it needs to render a listing: a plugin.json with a
// usable name. It records the skills a plugin holds but does not require any,
// and it ignores manifest fields it does not recognize. Both rules are there so
// that a plugin built out of something newer than this script -- a kind of
// content it has never heard of -- does not quietly fall out of the index.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TOPIC = "accountant24-plugin";
const OFFICIAL_OWNERS = new Set(["accountant24"]);
const MAX_SKILLS_PER_PLUGIN = 50;
const SEARCH_PAGE_LIMIT = 10; // the search API stops at 1000 results anyway

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const INDEX_FILE = "marketplace.json";
const BLOCKLIST_FILE = "blocklist.json";

const args = process.argv.slice(2);
const onlyRepo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

// --- GitHub access -----------------------------------------------------------

function headers(extra = {}) {
  const h = { "User-Agent": "accountant24-marketplace-indexer", ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** GET a REST API path. Undefined on 404; anything else that is not OK throws,
 *  so a half-finished run can never overwrite a good index. */
async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: headers({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return res.json();
}

/** Fetch a file at an exact commit over raw.githubusercontent.com (not counted
 *  against the REST rate limit). Undefined on 404. */
async function rawFile(repo, sha, path) {
  const res = await fetch(`${RAW}/${repo}/${sha}/${path}`, { headers: headers() });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`raw ${res.status} for ${repo}@${sha}:${path}`);
  return res.text();
}

async function searchTopic() {
  const seen = new Map();
  const q = encodeURIComponent(`topic:${TOPIC} archived:false`);
  for (let page = 1; page <= SEARCH_PAGE_LIMIT; page++) {
    const data = await api(`/search/repositories?q=${q}&sort=updated&order=desc&per_page=100&page=${page}`);
    if (!data) break;
    if (page === 1 && data.total_count > 1000) {
      console.warn(`warning: ${data.total_count} repositories carry the topic; the search API returns at most 1000`);
    }
    for (const item of data.items) seen.set(item.full_name.toLowerCase(), item);
    if (data.items.length < 100) break;
  }
  return [...seen.values()];
}

// --- Validation --------------------------------------------------------------

const NAMESPACE = "ai.accountant24";
const VERSION_RE = /^\d+\.\d+\.\d+/;
const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value) => (typeof value === "string" ? value : undefined);

function pluginNameError(name) {
  if (name.length === 0) return "name is empty";
  if (name.length > 64) return "name exceeds 64 characters";
  if (!/^[a-z0-9-]+$/.test(name)) return "name may only contain lowercase letters, numbers, and hyphens";
  if (name.startsWith("-") || name.endsWith("-")) return "name may not start or end with a hyphen";
  if (name.includes("--")) return "name may not contain consecutive hyphens";
  return undefined;
}

/** Pull the published fields out of a plugin.json. Only a usable name is
 *  required; every other field is taken when it has the right type and dropped
 *  when it does not. Returns { ok: true, manifest } or { ok: false, error }. */
function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "plugin.json is not valid JSON" };
  }
  if (!isPlainObject(raw)) return { ok: false, error: "plugin.json must contain a JSON object" };

  const name = str(raw.name);
  if (name === undefined) return { ok: false, error: "plugin.json: name is required" };
  const nameError = pluginNameError(name);
  if (nameError) return { ok: false, error: `plugin.json: ${nameError}` };

  const manifest = { name };
  for (const key of ["version", "description", "homepage", "license"]) manifest[key] = str(raw[key]);
  if (isPlainObject(raw.author)) {
    const author = {};
    for (const key of ["name", "email", "url"]) {
      const value = str(raw.author[key]);
      if (value !== undefined) author[key] = value;
    }
    if (Object.keys(author).length > 0) manifest.author = author;
  }
  if (Array.isArray(raw.keywords)) {
    const keywords = raw.keywords.filter((k) => typeof k === "string");
    if (keywords.length > 0) manifest.keywords = keywords;
  }
  const minAppVersion = str(raw.extensions?.[NAMESPACE]?.minAppVersion)?.trim();
  if (minAppVersion !== undefined && VERSION_RE.test(minAppVersion)) manifest.minAppVersion = minAppVersion;
  return { ok: true, manifest };
}

/** The subset of YAML that skill frontmatter uses: top-level `key: value`,
 *  plain or quoted, plus `>`/`|` block scalars and indented continuation
 *  lines. Undefined when there is no frontmatter block. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  const lines = match[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let value = (kv[2] ?? "").trim();
    if (value === "" || /^[>|][+-]?$/.test(value)) {
      const literal = value.startsWith("|");
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        block.push(lines[++i].trim());
      }
      while (block.length > 0 && block[block.length - 1] === "") block.pop();
      value = literal ? block.join("\n") : block.join(" ").replace(/\s+/g, " ").trim();
    } else {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) value += ` ${lines[++i].trim()}`;
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1).replace(/''/g, "'");
      }
    }
    out[key] = value;
  }
  return out;
}

// --- Indexing ----------------------------------------------------------------

/** Index one repository at one commit. Returns the plugin entry, or undefined
 *  after logging why the repository was skipped. */
async function indexRepo(item, sha) {
  const repo = item.full_name;
  const skip = (reason) => {
    console.log(`skipped ${repo}: ${reason}`);
    return undefined;
  };

  const text = await rawFile(repo, sha, "plugin.json");
  if (text === undefined) return skip("no plugin.json at the repository root");
  const parsed = parseManifest(text);
  if (!parsed.ok) return skip(parsed.error);
  const manifest = parsed.manifest;

  const contents = await api(`/repos/${repo}/contents/skills?ref=${sha}`);
  const folders = Array.isArray(contents)
    ? contents
        .filter((entry) => entry.type === "dir")
        .map((entry) => entry.name)
        .sort()
    : [];
  if (folders.length > MAX_SKILLS_PER_PLUGIN) {
    console.log(`${repo}: ${folders.length} skill folders, indexing the first ${MAX_SKILLS_PER_PLUGIN}`);
  }

  const skills = [];
  for (const folder of folders.slice(0, MAX_SKILLS_PER_PLUGIN)) {
    const path = `skills/${folder}/SKILL.md`;
    const drop = (reason) => console.log(`${repo}: ${path} skipped, ${reason}`);
    if (!SKILL_NAME_RE.test(folder)) {
      drop("skill folder names are lowercase letters, numbers, and hyphens (max 64)");
      continue;
    }
    const skillText = await rawFile(repo, sha, path);
    const fm = skillText === undefined ? undefined : parseFrontmatter(skillText);
    if (!fm) {
      drop("no SKILL.md with a frontmatter block");
      continue;
    }
    if (fm.name !== folder) {
      drop(`frontmatter name "${fm.name ?? ""}" does not match the folder name`);
      continue;
    }
    if (!fm.description) {
      drop("frontmatter has no description");
      continue;
    }
    skills.push({ name: folder, description: fm.description });
  }
  // A plugin with no skills still lists: it may hold a kind of content this
  // script does not index yet, and the app decides what is worth showing.
  if (skills.length === 0) console.log(`${repo}: listed with no skills`);

  return {
    // `id` is the key consumers store. It equals `repo` today, and stays the
    // key if a repository is ever allowed to hold more than one plugin.
    id: repo,
    name: manifest.name,
    description: manifest.description ?? "",
    version: manifest.version,
    author: manifest.author,
    license: manifest.license ?? item.license?.spdx_id ?? undefined,
    homepage: manifest.homepage,
    keywords: manifest.keywords,
    repo,
    defaultBranch: item.default_branch,
    commit: sha,
    minAppVersion: manifest.minAppVersion,
    skills,
    official: OFFICIAL_OWNERS.has(item.owner.login.toLowerCase()),
  };
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const blocklist = new Set(readJson(BLOCKLIST_FILE, []).map((b) => b.repo.toLowerCase()));

  let items;
  if (onlyRepo) {
    const item = await api(`/repos/${onlyRepo}`);
    if (!item) throw new Error(`repository not found: ${onlyRepo}`);
    items = [item];
  } else {
    items = (await searchTopic()).filter((item) => !item.private && !item.fork && !item.archived);
  }

  const plugins = [];
  for (const item of items) {
    const repo = item.full_name;
    if (blocklist.has(repo.toLowerCase())) {
      console.log(`skipped ${repo}: on the blocklist`);
      continue;
    }
    const ref = await api(`/repos/${repo}/git/ref/heads/${item.default_branch}`);
    const sha = ref?.object?.sha;
    if (!sha) {
      console.log(`skipped ${repo}: could not resolve the default branch`);
      continue;
    }
    const plugin = await indexRepo(item, sha);
    if (plugin) plugins.push(plugin);
  }
  plugins.sort((a, b) => a.id.localeCompare(b.id));

  if (onlyRepo) {
    console.log(stable(plugins[0] ?? null));
    return;
  }
  console.log(`${items.length} repositories with the topic, ${plugins.length} plugins listed`);
  writeFileSync(INDEX_FILE, stable({ schemaVersion: 1, topic: TOPIC, plugins }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
