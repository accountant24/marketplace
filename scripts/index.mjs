#!/usr/bin/env node
// Builds the Accountant24 plugin index (marketplace.json) from GitHub.
//
// A plugin is listed when a public, non-fork, non-archived repository carries
// the topic `accountant24-plugin` and its default branch holds a valid
// plugin.json (at the root, or up to two folders deep) with at least one valid
// skill under skills/. What was skipped, and why, goes to rejected.json so an
// author can see why their repository is not (fully) listed. blocklist.json is
// hand-maintained and always wins.
//
// Zero dependencies, Node 22. Runs in GitHub Actions every 30 minutes with the
// workflow's GITHUB_TOKEN. Locally: GITHUB_TOKEN=$(gh auth token) node scripts/index.mjs
//
// Flags:
//   --dry-run            compute and print, write nothing
//   --repo owner/name    index just this repository and print the result (skips
//                        the topic search and the private filter; for authors
//                        checking their own repository). Implies --dry-run.
//
// Validation rules mirror the desktop app's install-time checks
// (packages/desktop/src/main/agent/plugin-manifest.ts and plugins-store.ts in
// machulav/accountant24). The app re-validates on install, so a stale rule here
// can only over- or under-list, never install something the app rejects.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TOPIC = "accountant24-plugin";
const OFFICIAL_OWNERS = new Set(["accountant24"]);
const MAX_MANIFEST_DEPTH = 2;
const MAX_PLUGINS_PER_REPO = 20;
const MAX_SKILLS_PER_PLUGIN = 50;
const SEARCH_PAGE_LIMIT = 10; // the search API stops at 1000 results anyway

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const INDEX_FILE = "marketplace.json";
const REJECTED_FILE = "rejected.json";
const BLOCKLIST_FILE = "blocklist.json";
const README_FILE = "README.md";
const README_START = "<!-- plugins:start -->";
const README_END = "<!-- plugins:end -->";

const args = process.argv.slice(2);
const onlyRepo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined;
const dryRun = args.includes("--dry-run") || onlyRepo !== undefined;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

// --- GitHub access -----------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headers(extra = {}) {
  const h = { "User-Agent": "accountant24-marketplace", ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** GET a REST API path. Undefined on 404; waits out a rate limit once; any
 *  other failure throws so a broken run never commits a partial index. */
async function api(path) {
  const url = `${API}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: headers({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }),
    });
    if (res.status === 404) return undefined;
    if ((res.status === 403 || res.status === 429) && attempt === 0) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const remaining = res.headers.get("x-ratelimit-remaining");
      const wait =
        retryAfter > 0 ? retryAfter : remaining === "0" && reset > 0 ? reset - Math.floor(Date.now() / 1000) : 0;
      if (wait > 0 && wait <= 180) {
        console.warn(`rate limited on ${path}; waiting ${wait}s`);
        await sleep(wait * 1000 + 500);
        continue;
      }
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
    return res.json();
  }
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

// --- Validation (mirrors the app) --------------------------------------------

const KNOWN_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const NAMESPACE = "ai.accountant24";
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)/;
const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluginNameError(name) {
  if (name.length === 0) return "name is empty";
  if (name.length > 64) return "name exceeds 64 characters";
  if (!/^[a-z0-9-]+$/.test(name)) return "name may only contain lowercase letters, numbers, and hyphens";
  if (name.startsWith("-") || name.endsWith("-")) return "name may not start or end with a hyphen";
  if (name.includes("--")) return "name may not contain consecutive hyphens";
  return undefined;
}

/** Parse and validate a plugin.json. Returns { ok: true, manifest } or { ok: false, error }. */
function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "plugin.json is not valid JSON" };
  }
  if (!isPlainObject(raw)) return { ok: false, error: "plugin.json must contain a JSON object" };
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) return { ok: false, error: `plugin.json: unknown field ${unknown.sort().join(", ")}` };
  if (typeof raw.name !== "string") return { ok: false, error: "plugin.json: name is required" };
  const nameError = pluginNameError(raw.name);
  if (nameError) return { ok: false, error: `plugin.json: ${nameError}` };
  const manifest = { name: raw.name };
  for (const key of ["version", "description", "homepage", "repository", "license"]) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string") return { ok: false, error: `plugin.json: ${key} must be a string` };
    manifest[key] = raw[key];
  }
  if (raw.author !== undefined) {
    if (!isPlainObject(raw.author)) return { ok: false, error: "plugin.json: author must be an object" };
    manifest.author = {};
    for (const key of ["name", "email", "url"]) {
      if (raw.author[key] === undefined) continue;
      if (typeof raw.author[key] !== "string") return { ok: false, error: `plugin.json: author.${key} must be a string` };
      manifest.author[key] = raw.author[key];
    }
  }
  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords) || raw.keywords.some((k) => typeof k !== "string")) {
      return { ok: false, error: "plugin.json: keywords must be an array of strings" };
    }
    manifest.keywords = raw.keywords;
  }
  if (raw.extensions !== undefined) {
    if (!isPlainObject(raw.extensions)) return { ok: false, error: "plugin.json: extensions must be an object" };
    const ours = raw.extensions[NAMESPACE];
    if (ours !== undefined) {
      if (!isPlainObject(ours)) return { ok: false, error: `plugin.json: extensions["${NAMESPACE}"] must be an object` };
      if (ours.minAppVersion !== undefined) {
        if (typeof ours.minAppVersion !== "string" || !VERSION_RE.test(ours.minAppVersion.trim())) {
          return { ok: false, error: "plugin.json: minAppVersion must be a version like 1.2.3" };
        }
        manifest.minAppVersion = ours.minAppVersion.trim();
      }
    }
  }
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

function depthOf(path) {
  return path.split("/").length - 1;
}

function isHiddenPath(path) {
  return path.split("/").some((part) => part.startsWith(".") || part === "node_modules");
}

/** Index one repository at one commit. Returns { plugins, rejected }. */
async function indexRepo(item, sha) {
  const repo = item.full_name;
  const plugins = [];
  const rejected = [];
  const reject = (path, reason) => rejected.push({ repo, path, commit: sha, reason });

  const tree = await api(`/repos/${repo}/git/trees/${sha}?recursive=1`);
  if (!tree) {
    reject("", "could not read the repository tree");
    return { plugins, rejected };
  }
  if (tree.truncated) console.warn(`warning: tree of ${repo} is truncated; some files may be missed`);
  const blobs = new Set(tree.tree.filter((e) => e.type === "blob").map((e) => e.path));

  const manifestPaths = [...blobs]
    .filter((p) => (p === "plugin.json" || p.endsWith("/plugin.json")) && !isHiddenPath(p))
    .filter((p) => depthOf(p) <= MAX_MANIFEST_DEPTH)
    .sort();
  if (manifestPaths.length === 0) {
    reject("", "no plugin.json found (root, or up to two folders deep)");
    return { plugins, rejected };
  }
  if (manifestPaths.length > MAX_PLUGINS_PER_REPO) {
    console.warn(`warning: ${repo} has ${manifestPaths.length} manifests; indexing the first ${MAX_PLUGINS_PER_REPO}`);
  }

  for (const manifestPath of manifestPaths.slice(0, MAX_PLUGINS_PER_REPO)) {
    const dir = manifestPath === "plugin.json" ? "" : manifestPath.slice(0, -"plugin.json".length);
    const subpath = dir.replace(/\/$/, "");
    const text = await rawFile(repo, sha, manifestPath);
    if (text === undefined) {
      reject(manifestPath, "plugin.json could not be fetched");
      continue;
    }
    const parsed = parseManifest(text);
    if (!parsed.ok) {
      reject(manifestPath, parsed.error);
      continue;
    }
    const manifest = parsed.manifest;

    const skillFiles = [...blobs]
      .filter((p) => p.startsWith(`${dir}skills/`) && p.endsWith("/SKILL.md"))
      .filter((p) => p.slice(dir.length).split("/").length === 3)
      .sort();
    if (skillFiles.length > MAX_SKILLS_PER_PLUGIN) {
      console.warn(`warning: ${repo}/${subpath} has ${skillFiles.length} skills; indexing the first ${MAX_SKILLS_PER_PLUGIN}`);
    }
    const skills = [];
    for (const skillFile of skillFiles.slice(0, MAX_SKILLS_PER_PLUGIN)) {
      const folder = skillFile.slice(dir.length).split("/")[1];
      if (!SKILL_NAME_RE.test(folder)) {
        reject(skillFile, "skill folder names are lowercase letters, numbers, and hyphens (max 64)");
        continue;
      }
      const skillText = await rawFile(repo, sha, skillFile);
      const fm = skillText === undefined ? undefined : parseFrontmatter(skillText);
      if (!fm) {
        reject(skillFile, "SKILL.md has no frontmatter block");
        continue;
      }
      if (fm.name !== folder) {
        reject(skillFile, `frontmatter name "${fm.name ?? ""}" does not match the folder name`);
        continue;
      }
      if (!fm.description) {
        reject(skillFile, "SKILL.md frontmatter has no description");
        continue;
      }
      skills.push({ name: folder, description: fm.description });
    }
    if (skills.length === 0) {
      reject(manifestPath, "no valid skill under skills/");
      continue;
    }

    plugins.push({
      id: subpath ? `${repo}/${subpath}` : repo,
      name: manifest.name,
      description: manifest.description ?? "",
      version: manifest.version,
      author: manifest.author,
      license: manifest.license ?? item.license?.spdx_id ?? undefined,
      homepage: manifest.homepage,
      keywords: manifest.keywords,
      repo,
      subpath,
      defaultBranch: item.default_branch,
      commit: sha,
      stars: item.stargazers_count,
      pushedAt: item.pushed_at,
      minAppVersion: manifest.minAppVersion,
      skills,
      official: OFFICIAL_OWNERS.has(item.owner.login.toLowerCase()),
    });
  }
  return { plugins, rejected };
}

/** Bring a reused entry's volatile repository fields up to date. */
function refresh(entry, item) {
  return { ...entry, stars: item.stargazers_count, pushedAt: item.pushed_at };
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderReadmeTable(plugins) {
  if (plugins.length === 0) return "_No plugins indexed yet._";
  const rows = plugins.map((p) => {
    const link = `https://github.com/${p.repo}${p.subpath ? `/tree/${p.defaultBranch}/${p.subpath}` : ""}`;
    const skills = p.skills.map((s) => `\`${p.name}:${s.name}\``).join(", ");
    const badge = p.official ? " (official)" : "";
    return `| [${p.name}](${link})${badge} | ${p.description.replace(/\|/g, "\\|")} | ${p.stars} | ${skills} |`;
  });
  return ["| Plugin | Description | Stars | Skills |", "| --- | --- | ---: | --- |", ...rows].join("\n");
}

async function main() {
  const previous = readJson(INDEX_FILE, { plugins: [] });
  const previousRejected = readJson(REJECTED_FILE, []);
  const blocklist = new Set(readJson(BLOCKLIST_FILE, []).map((b) => b.repo.toLowerCase()));

  let items;
  if (onlyRepo) {
    const item = await api(`/repos/${onlyRepo}`);
    if (!item) throw new Error(`repository not found: ${onlyRepo}`);
    items = [item];
  } else {
    items = (await searchTopic()).filter((item) => !item.private && !item.fork && !item.archived);
  }

  const prevByRepo = new Map();
  for (const entry of previous.plugins) {
    if (!prevByRepo.has(entry.repo)) prevByRepo.set(entry.repo, []);
    prevByRepo.get(entry.repo).push(entry);
  }
  const prevRejectedByRepo = new Map();
  for (const entry of previousRejected) {
    if (!prevRejectedByRepo.has(entry.repo)) prevRejectedByRepo.set(entry.repo, []);
    prevRejectedByRepo.get(entry.repo).push(entry);
  }

  const plugins = [];
  const rejected = [];
  let reused = 0;
  for (const item of items) {
    const repo = item.full_name;
    if (blocklist.has(repo.toLowerCase())) continue;
    const ref = await api(`/repos/${repo}/git/ref/heads/${item.default_branch}`);
    const sha = ref?.object?.sha;
    if (!sha) {
      rejected.push({ repo, path: "", commit: "", reason: "could not resolve the default branch" });
      continue;
    }
    const prevEntries = prevByRepo.get(repo) ?? [];
    const prevRejects = prevRejectedByRepo.get(repo) ?? [];
    const known = [...prevEntries, ...prevRejects];
    if (!onlyRepo && known.length > 0 && known.every((e) => e.commit === sha)) {
      plugins.push(...prevEntries.map((e) => refresh(e, item)));
      rejected.push(...prevRejects);
      reused++;
      continue;
    }
    const result = await indexRepo(item, sha);
    plugins.push(...result.plugins);
    rejected.push(...result.rejected);
  }

  plugins.sort((a, b) => a.id.localeCompare(b.id));
  rejected.sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));

  if (onlyRepo) {
    console.log(stable({ plugins, rejected }));
    return;
  }

  const unchanged = JSON.stringify(plugins) === JSON.stringify(previous.plugins);
  const index = {
    schemaVersion: 1,
    topic: TOPIC,
    updatedAt: unchanged && previous.updatedAt ? previous.updatedAt : new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    plugins,
  };

  console.log(
    `${items.length} repositories with the topic, ${plugins.length} plugins listed, ${rejected.length} rejections, ${reused} repositories unchanged`,
  );
  if (dryRun) {
    console.log(stable(index));
    return;
  }

  writeFileSync(INDEX_FILE, stable(index));
  writeFileSync(REJECTED_FILE, stable(rejected));
  if (existsSync(README_FILE)) {
    const readme = readFileSync(README_FILE, "utf8");
    const start = readme.indexOf(README_START);
    const end = readme.indexOf(README_END);
    if (start !== -1 && end > start) {
      const next = `${readme.slice(0, start + README_START.length)}\n${renderReadmeTable(plugins)}\n${readme.slice(end)}`;
      if (next !== readme) writeFileSync(README_FILE, next);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
