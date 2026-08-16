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
// Zero dependencies, Node 22.7 or newer. Runs in GitHub Actions with the
// workflow's GITHUB_TOKEN. Locally: GITHUB_TOKEN=$(gh auth token) node scripts/index.mjs
//
// Flags:
//   --repo owner/name   index just this repository, print the result, and write
//                       nothing. Skips the topic search and the blocklist, so it
//                       needs no checkout around it: an author can pipe this
//                       file straight from raw.githubusercontent.com into node
//                       to see what the index would make of their repository.
//
// The desktop app validates every manifest again at install time, so this
// script checks only what it needs to render a listing: a plugin.json that
// declares the Agent Plugins manifest schema, carries a usable name, and holds
// nothing the manifest format does not define. The format closes the object, so
// anything client-specific belongs under `extensions`, which is the field the
// spec provides for it.
//
// Content works the other way round. The script records the skills a plugin
// holds but does not require any, so that a plugin built out of something newer
// than this script -- a kind of content it has never heard of -- does not
// quietly fall out of the index.
//
// Every entry keeps its two sources of truth apart. `manifest` is what the
// author declared in plugin.json; `repo` is what GitHub says about the
// repository it came from. Nothing is merged across the two, so a consumer can
// always tell a claim from an observation -- worth having when listing is
// automatic and nobody reviews what an author writes about themselves. Where
// both hold a license, both are published and the app decides.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SCHEMA_VERSION = 1;
const TOPIC = "accountant24-plugin";
// Numeric account ids, not logins. `official` is the strongest claim the index
// makes, and a login is only borrowed: rename or delete the accountant24
// organization and whoever claims the freed name would inherit the badge on
// everything they publish. An account id is the account itself, so it cannot be
// handed to someone else.
const OFFICIAL_OWNERS = new Set([
  268739799, // accountant24
]);
const MAX_SKILLS_PER_PLUGIN = 50;
const SEARCH_PAGE_LIMIT = 10; // the search API stops at 1000 results anyway

// marketplace.json is public and every client downloads it, so no single
// repository gets to decide how big it is. The longest description in the index
// today runs to about 550 characters, so 1024 is room to write in, not a budget
// to hit.
const LIMITS = {
  description: 1024,
  version: 64,
  license: 64,
  url: 512,
  authorName: 128,
  authorEmail: 254, // the longest address RFC 5321 allows
  keywords: 20,
  keyword: 64,
};

const DOCS = "See https://accountant24.ai/docs/create-a-plugin for the format.";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const INDEX_FILE = "marketplace.json";
const BLOCKLIST_FILE = "blocklist.json";

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

// --- GitHub access -----------------------------------------------------------

function headers(extra = {}) {
  const h = { "User-Agent": "accountant24-marketplace-indexer", ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

const WITH_TOKEN = "run it again with GITHUB_TOKEN=$(gh auth token) in front";

/** What the reader can actually do about a request GitHub turned down. */
function advice(res) {
  if (res.status === 401) return "That GitHub token was rejected. Sign in again with `gh auth login`, then retry.";
  if (res.status === 403 || res.status === 429) {
    return res.headers.get("x-ratelimit-remaining") === "0"
      ? `You have used up GitHub's rate limit. Wait a few minutes, or ${WITH_TOKEN} for a much higher one.`
      : `GitHub would not allow that. If the repository is private, ${WITH_TOKEN}.`;
  }
  if (res.status >= 500) return "GitHub is having trouble of its own. Try again in a few minutes.";
  return "";
}

/** GET a REST API path. Undefined on 404; anything else that is not OK throws,
 *  so a half-finished run can never overwrite a good index. */
async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: headers({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    // The API path means nothing to a plugin author, so it only leads when
    // there is no plainer thing to say about the status.
    const help = advice(res);
    throw new Error(help ? `${help} (GitHub returned ${res.status}.)` : `GitHub returned ${res.status} for ${path}.`);
  }
  return res.json();
}

/** Fetch a file at an exact commit over raw.githubusercontent.com (not counted
 *  against the REST rate limit). Undefined on 404. */
async function rawFile(repo, sha, path) {
  const res = await fetch(`${RAW}/${repo}/${sha}/${path}`, { headers: headers() });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`Could not read ${path} from ${repo}: GitHub returned ${res.status}. ${advice(res)}`.trimEnd());
  }
  return res.text();
}

export async function searchTopic() {
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

// The manifest format, as an author would write it into "$schema".
const SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
// Any version of it is accepted, not the 1.0.0 above alone. Pinning one would
// delist every plugin in the index the day the format gains a version, which is
// too much to hang on a string an author has to remember to update.
const SCHEMA_URL_RE = /^https:\/\/agent-plugins\.org\/schemas\/[^/]+\/plugin\.schema\.json$/;

// Every top-level key the manifest format defines. It closes the object, so a
// key that is not here is not a manifest field, whatever it looks like.
// `repository` is listed because the format defines it, though the index does
// not publish it: what the repository is, is `repo`'s to say, not the author's.
const MANIFEST_KEYS = new Set([
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

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value) => (typeof value === "string" ? value : undefined);

/** Text the index shows a reader. An overlong one is clipped, because half a
 *  description still tells them something. */
function prose(value, limit) {
  const text = str(value);
  if (text === undefined || text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** A version, a license, a URL, a name. An overlong one is dropped rather than
 *  clipped, because half of any of these is not a shorter one, it is a wrong
 *  one -- a truncated URL still looks like somewhere to go. */
function ident(value, limit) {
  const text = str(value);
  return text !== undefined && text.length <= limit ? text : undefined;
}

export function pluginNameError(name) {
  if (name.length === 0) return "name is empty.";
  if (name.length > 64) return "name is longer than 64 characters.";
  if (!/^[a-z0-9-]+$/.test(name)) return "name may only hold lowercase letters, numbers and hyphens.";
  if (name.startsWith("-") || name.endsWith("-")) return "name may not start or end with a hyphen.";
  if (name.includes("--")) return "name may not hold two hyphens in a row.";
  return undefined;
}

/** Pull the published fields out of a plugin.json. Only a usable name is
 *  required; every other field is taken when it has the right type and fits
 *  inside LIMITS, and dropped or clipped when it does not. The result is a
 *  projection, not a copy: unknown keys never reach the index, and
 *  minAppVersion comes out flat rather than under `extensions`.
 *  Returns { ok: true, manifest } or { ok: false, error }. */
export function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "its plugin.json is not valid JSON. A trailing comma or a missing quote is the usual cause." };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'its plugin.json must hold a JSON object, like { "name": "my-plugin" }.' };
  }

  const schema = str(raw.$schema);
  if (schema === undefined || !SCHEMA_URL_RE.test(schema)) {
    return {
      ok: false,
      error: `its plugin.json does not say which manifest format it is written in. Add "$schema": "${SCHEMA_URL}" as the first key. ${DOCS}`,
    };
  }

  const name = str(raw.name);
  if (name === undefined) return { ok: false, error: 'its plugin.json has no name. Add one, like "name": "my-plugin".' };
  const nameError = pluginNameError(name);
  if (nameError) return { ok: false, error: `its plugin.json ${nameError}` };

  const unknown = Object.keys(raw)
    .filter((key) => !MANIFEST_KEYS.has(key))
    .sort();
  if (unknown.length > 0) {
    const keys = unknown.join(", ");
    return {
      ok: false,
      error:
        `its plugin.json holds ${unknown.length === 1 ? "a key" : "keys"} the manifest format does not define: ${keys}. ` +
        `Remove ${unknown.length === 1 ? "it" : "them"}, or move anything meant for a particular app under "extensions". ${DOCS}`,
    };
  }

  // Built in the order the published entry reads, since that is the order the
  // file -- and so every diff of it -- comes out in.
  const manifest = { name };
  manifest.description = prose(raw.description, LIMITS.description);
  manifest.version = ident(raw.version, LIMITS.version);
  if (isPlainObject(raw.author)) {
    const author = {};
    const fields = { name: LIMITS.authorName, email: LIMITS.authorEmail, url: LIMITS.url };
    for (const [key, limit] of Object.entries(fields)) {
      const value = ident(raw.author[key], limit);
      if (value !== undefined) author[key] = value;
    }
    if (Object.keys(author).length > 0) manifest.author = author;
  }
  manifest.license = ident(raw.license, LIMITS.license);
  manifest.homepage = ident(raw.homepage, LIMITS.url);
  if (Array.isArray(raw.keywords)) {
    const keywords = raw.keywords
      .map((k) => ident(k, LIMITS.keyword))
      .filter((k) => k !== undefined)
      .slice(0, LIMITS.keywords);
    if (keywords.length > 0) manifest.keywords = keywords;
  }
  const minAppVersion = str(raw.extensions?.[NAMESPACE]?.minAppVersion)?.trim();
  if (minAppVersion !== undefined && VERSION_RE.test(minAppVersion)) manifest.minAppVersion = minAppVersion;
  return { ok: true, manifest };
}

/** The subset of YAML that skill frontmatter uses: top-level `key: value`,
 *  plain or quoted, plus `>`/`|` block scalars and indented continuation
 *  lines. Undefined when there is no frontmatter block. */
export function parseFrontmatter(text) {
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

/** Why a repository can never be listed, whatever else is true of it, or
 *  undefined when nothing rules it out. Private is not here on purpose: an
 *  author may well preview a repository before making it public. */
export function excluded(item) {
  if (item.fork) return "it is a fork, and forks are never listed. Publish the plugin from a repository of its own.";
  if (item.archived) return "it is archived, and archived repositories are never listed. Unarchive it to be indexed.";
  return undefined;
}

/** Index one repository at one commit. Returns the plugin entry, or undefined
 *  after logging why the repository was skipped. */
export async function indexRepo(item, sha) {
  const repo = item.full_name;
  const skip = (reason) => {
    console.log(`${repo} is not listed: ${reason}`);
    return undefined;
  };

  const text = await rawFile(repo, sha, "plugin.json");
  if (text === undefined) return skip(`there is no plugin.json at the root. ${DOCS}`);
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
    console.log(`${repo} has ${folders.length} skill folders; only the first ${MAX_SKILLS_PER_PLUGIN}, in alphabetical order, are listed.`);
  }

  const skills = [];
  for (const folder of folders.slice(0, MAX_SKILLS_PER_PLUGIN)) {
    const path = `skills/${folder}/SKILL.md`;
    const drop = (reason) => console.log(`${repo}: the skill in skills/${folder} is not listed. ${reason}`);
    if (!SKILL_NAME_RE.test(folder)) {
      drop("Folder names may only hold lowercase letters, numbers and hyphens, up to 64 of them. Rename it.");
      continue;
    }
    const skillText = await rawFile(repo, sha, path);
    const fm = skillText === undefined ? undefined : parseFrontmatter(skillText);
    if (!fm) {
      drop(`There is no ${path}, or it does not open with a --- frontmatter block. ${DOCS}`);
      continue;
    }
    if (fm.name !== folder) {
      drop(`Its frontmatter says name: ${fm.name ?? "(nothing)"}, but the folder is called ${folder}. Make the two match.`);
      continue;
    }
    if (!fm.description) {
      drop("Its frontmatter has no description. Add one: it is what the app shows, and how the agent knows when to use the skill.");
      continue;
    }
    skills.push({ name: folder, description: prose(fm.description, LIMITS.description) });
  }
  // A plugin with no skills still lists: it may hold a kind of content this
  // script does not index yet, and the app decides what is worth showing.
  if (skills.length === 0) console.log(`${repo} is listed, but with no skills under skills/.`);

  const owner = item.owner;
  return {
    // `id` is the key consumers store. It equals owner/name today, and stays
    // the key if a repository is ever allowed to hold more than one plugin.
    id: repo,
    official: OFFICIAL_OWNERS.has(owner.id),
    manifest,
    repo: {
      owner: {
        login: owner.login,
        // The numeric ids are the only identifiers that survive a rename. Two
        // runs where the login matches but the id does not mean the account
        // behind a listing changed hands -- which, for a login that was freed
        // up and claimed by someone else, is the whole attack.
        id: owner.id,
        type: owner.type,
        url: owner.html_url ?? `https://github.com/${owner.login}`,
        avatarUrl: owner.avatar_url,
      },
      name: item.name,
      id: item.id,
      url: item.html_url ?? `https://github.com/${repo}`,
      defaultBranch: item.default_branch,
      commit: sha,
      // GitHub detects this from the LICENSE file, and says NOASSERTION when it
      // cannot place what it found. That is not an SPDX id, so it is not one here.
      license: item.license?.spdx_id === "NOASSERTION" ? undefined : item.license?.spdx_id,
      description: prose(item.description, LIMITS.description),
    },
    skills,
  };
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Every plugin that should be listed, from a set of repositories, sorted by id.
 *  Touches no files, so it is the same decision in --repo mode as in a full run. */
export async function collect(items, blocklist = new Set()) {
  const plugins = [];
  for (const item of items) {
    const repo = item.full_name;
    const why = excluded(item);
    if (why) {
      console.log(`${repo} is not listed: ${why}`);
      continue;
    }
    if (blocklist.has(repo.toLowerCase())) {
      console.log(`${repo} is not listed: it is on the blocklist. See blocklist.json for the reason.`);
      continue;
    }
    const ref = await api(`/repos/${repo}/git/ref/heads/${item.default_branch}`);
    const sha = ref?.object?.sha;
    if (!sha) {
      const branch = item.default_branch;
      console.log(`${repo} is not listed: its ${branch} branch has no commits to read. Push one first.`);
      continue;
    }
    const plugin = await indexRepo(item, sha);
    if (plugin) plugins.push(plugin);
  }
  return plugins.sort((a, b) => a.id.localeCompare(b.id));
}

export async function main(argv = process.argv.slice(2)) {
  const flag = argv.indexOf("--repo");
  const onlyRepo = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && !onlyRepo) throw new Error("--repo needs a repository to look at, like: --repo owner/name");

  if (onlyRepo) {
    const item = await api(`/repos/${onlyRepo}`);
    if (!item) {
      throw new Error(
        `There is no repository at github.com/${onlyRepo}. Check the owner/name spelling; if it is private, ${WITH_TOKEN}.`,
      );
    }
    // Nothing on disk is consulted here: the script may have been piped in from
    // raw.githubusercontent.com, where reading blocklist.json would mean reading
    // whatever happens to sit in the author's working directory.
    const plugins = await collect([item]);
    console.log(stable(plugins[0] ?? null));
    return;
  }

  const blocklist = new Set(readJson(BLOCKLIST_FILE, []).map((b) => b.repo.toLowerCase()));
  const items = (await searchTopic()).filter((item) => !item.private);
  const plugins = await collect(items, blocklist);
  console.log(`${items.length} repositories with the topic, ${plugins.length} plugins listed`);
  writeFileSync(INDEX_FILE, stable({ schemaVersion: SCHEMA_VERSION, topic: TOPIC, plugins }));
}

// Run only when this file is the program: as a file, or piped in as `node -`,
// which is how an author previews a repository straight from a URL. Importing
// it -- as the tests do -- must not kick off a run.
if (process.argv[1] === "-" || import.meta.filename === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
