// What the indexer is supposed to do, written from the rules in README.md
// rather than from the code below it. A test here failing means either the
// script is wrong or the rule changed -- not that the test needs relaxing.
//
// Run with: node --test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { collect, excluded, indexRepo, main, parseFrontmatter, parseManifest, pluginNameError, searchTopic } from "./index.mjs";

// The script narrates what it skips. Useful in a real run, noise in a test.
console.log = () => {};

// --- a fake GitHub -----------------------------------------------------------

const response = ({ status = 200, json, text, headers = {} }) => ({
  status,
  ok: status < 400,
  headers: { get: (name) => headers[name] ?? null },
  json: async () => json,
  text: async () => text,
});

/** Serve a set of repositories over a stubbed fetch. Each is
 *  { full_name, sha?, default_branch?, fork?, archived?, private?, license?,
 *    id?, ownerId?, ownerType?, description?, files: { "path": "contents" } },
 *  and skills/ is derived from the files. */
function stubGitHub(repos) {
  const list = repos.map((r) => ({ sha: "c0ffee", default_branch: "main", files: {}, ...r }));
  const byName = new Map(list.map((r) => [r.full_name, r]));
  // Shaped like what the REST API actually returns, because the indexer
  // publishes fields straight off it: a stub that leaves them out would let a
  // missing one through as undefined and never fail a test.
  const item = (r) => {
    const [login, name] = r.full_name.split("/");
    const ownerId = r.ownerId ?? 2000;
    return {
      id: r.id ?? 1000,
      name,
      full_name: r.full_name,
      html_url: `https://github.com/${r.full_name}`,
      description: r.description,
      default_branch: r.default_branch,
      owner: {
        login,
        id: ownerId,
        type: r.ownerType ?? "Organization",
        html_url: `https://github.com/${login}`,
        avatar_url: `https://avatars.githubusercontent.com/u/${ownerId}?v=4`,
      },
      fork: Boolean(r.fork),
      archived: Boolean(r.archived),
      private: Boolean(r.private),
      license: r.license,
    };
  };

  globalThis.fetch = async (url) => {
    const u = String(url);

    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/?]+)\/(.+)$/.exec(u);
    if (raw) {
      const repo = byName.get(raw[1]);
      const body = repo && repo.sha === raw[2] ? repo.files[raw[3]] : undefined;
      return response(body === undefined ? { status: 404 } : { text: body });
    }

    const path = u.replace("https://api.github.com", "");

    if (path.startsWith("/search/repositories")) {
      const query = new URLSearchParams(path.split("?")[1]);
      const per = Number(query.get("per_page") ?? 100);
      const page = Number(query.get("page") ?? 1);
      const items = list.slice((page - 1) * per, page * per).map(item);
      return response({ json: { total_count: list.length, items } });
    }

    const ref = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/.exec(path);
    if (ref) {
      const repo = byName.get(ref[1]);
      if (!repo || repo.default_branch !== ref[2]) return response({ status: 404 });
      return response({ json: { object: { sha: repo.sha } } });
    }

    const contents = /^\/repos\/([^/]+\/[^/]+)\/contents\/skills\?ref=(.+)$/.exec(path);
    if (contents) {
      const repo = byName.get(contents[1]);
      const folders = [...new Set(Object.keys(repo?.files ?? {}).filter((p) => p.startsWith("skills/")).map((p) => p.split("/")[1]))];
      if (!repo || folders.length === 0) return response({ status: 404 });
      return response({ json: folders.map((name) => ({ name, type: "dir" })) });
    }

    const one = /^\/repos\/([^/]+\/[^/]+)$/.exec(path);
    if (one) {
      const repo = byName.get(one[1]);
      return repo ? response({ json: item(repo) }) : response({ status: 404 });
    }

    throw new Error(`unstubbed request: ${u}`);
  };
  return list.map(item);
}

const skillFile = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nHow to do the thing.\n`;
const manifest = (fields) => JSON.stringify({ name: "a-plugin", ...fields });

/** The one repository most tests start from: valid, two skills, nothing odd. */
const plainRepo = (overrides = {}) => ({
  full_name: "someone/plugin",
  files: {
    "plugin.json": manifest({ description: "Does a thing.", version: "1.0.0" }),
    "skills/second/SKILL.md": skillFile("second", "The second skill."),
    "skills/first/SKILL.md": skillFile("first", "The first skill."),
  },
  ...overrides,
});

// --- plugin names ------------------------------------------------------------

test("a plugin name is lowercase letters, numbers and hyphens", () => {
  for (const name of ["a", "plugin", "my-plugin", "plugin24", "a".repeat(64)]) {
    assert.equal(pluginNameError(name), undefined, `${name} should be allowed`);
  }
  for (const name of ["", "a".repeat(65), "My-Plugin", "my_plugin", "my plugin", "my.plugin", "-plugin", "plugin-", "my--plugin"]) {
    assert.ok(pluginNameError(name), `${name} should be rejected`);
  }
});

// --- the manifest ------------------------------------------------------------

test("a name is the only thing a manifest must have", () => {
  const { ok, manifest: parsed } = parseManifest('{"name":"a-plugin"}');
  assert.equal(ok, true);
  assert.equal(parsed.name, "a-plugin");
});

test("a manifest with no usable name is not a plugin", () => {
  for (const text of ['{"description":"no name"}', '{"name":42}', '{"name":"Bad Name"}']) {
    assert.equal(parseManifest(text).ok, false, `${text} should be rejected`);
  }
});

test("something that is not a JSON object is not a manifest", () => {
  for (const text of ["not json at all", "[1,2,3]", '"a string"', "null"]) {
    assert.equal(parseManifest(text).ok, false, `${text} should be rejected`);
  }
});

test("a field the indexer has never heard of does not cost a plugin its listing", () => {
  // The whole point: the app may ship a new manifest field before this script
  // learns about it, and a plugin using it must stay in the index.
  const { ok, manifest: parsed } = parseManifest(
    '{"name":"a-plugin","$schema":"https://example.com/s.json","repository":"https://github.com/a/b","pages":["home"]}',
  );
  assert.equal(ok, true);
  assert.equal(parsed.name, "a-plugin");
});

test("the published fields are taken from the manifest", () => {
  const { manifest: parsed } = parseManifest(
    manifest({
      version: "2.1.0",
      description: "Tracks things.",
      homepage: "https://example.com",
      license: "MIT",
      author: { name: "Ada", email: "ada@example.com", url: "https://example.com/ada" },
      keywords: ["money", "budget"],
    }),
  );
  assert.equal(parsed.version, "2.1.0");
  assert.equal(parsed.description, "Tracks things.");
  assert.equal(parsed.homepage, "https://example.com");
  assert.equal(parsed.license, "MIT");
  assert.deepEqual(parsed.author, { name: "Ada", email: "ada@example.com", url: "https://example.com/ada" });
  assert.deepEqual(parsed.keywords, ["money", "budget"]);
});

test("a field of the wrong type is dropped, not fatal", () => {
  const { ok, manifest: parsed } = parseManifest(
    manifest({ version: 42, description: null, author: "Ada", keywords: "money" }),
  );
  assert.equal(ok, true, "the plugin still lists");
  assert.equal(parsed.version, undefined);
  assert.equal(parsed.description, undefined);
  assert.equal(parsed.author, undefined);
  assert.equal(parsed.keywords, undefined);
});

test("only the string parts of author and keywords survive", () => {
  const { manifest: parsed } = parseManifest(manifest({ author: { name: "Ada", email: 42 }, keywords: ["money", 7] }));
  assert.deepEqual(parsed.author, { name: "Ada" });
  assert.deepEqual(parsed.keywords, ["money"]);
});

// --- how much of the index one repository gets to use ------------------------
//
// marketplace.json is public and every client downloads it. Nothing here is
// about the author doing something wrong; it is about no single repository
// being able to decide how big the file is for everyone else.

test("a description too long to publish is clipped rather than dropped", () => {
  const { manifest: parsed } = parseManifest(manifest({ description: "a".repeat(5000) }));
  assert.equal(parsed.description.length, 1024, "clipped to the limit");
  assert.ok(parsed.description.endsWith("…"), "and says that it was");
});

test("a description that fits is left exactly as written", () => {
  const written = "Tracks things. ".repeat(10).trim();
  assert.equal(parseManifest(manifest({ description: written })).manifest.description, written);
});

test("an identifier too long to publish is dropped, because a clipped one would mislead", () => {
  const { ok, manifest: parsed } = parseManifest(
    manifest({
      version: "1".repeat(65),
      license: "M".repeat(65),
      homepage: `https://example.com/${"p".repeat(500)}`,
      author: { name: "A".repeat(129), email: `${"a".repeat(250)}@example.com`, url: `https://example.com/${"u".repeat(500)}` },
    }),
  );
  assert.equal(ok, true, "the plugin still lists");
  assert.equal(parsed.version, undefined);
  assert.equal(parsed.license, undefined);
  assert.equal(parsed.homepage, undefined);
  assert.equal(parsed.author, undefined, "every part of it went, so the author did too");
});

test("keywords are capped in number and in length", () => {
  const { manifest: parsed } = parseManifest(
    manifest({ keywords: [...Array.from({ length: 25 }, (_, i) => `tag-${i}`), "k".repeat(65)] }),
  );
  assert.equal(parsed.keywords.length, 20);
  assert.ok(!parsed.keywords.some((k) => k.length > 64), "the overlong one never made it in");
});

test("minAppVersion is read from the accountant24 namespace, and must look like a version", () => {
  const of = (extensions) => parseManifest(manifest({ extensions })).manifest.minAppVersion;
  assert.equal(of({ "ai.accountant24": { minAppVersion: " 1.2.3 " } }), "1.2.3", "trimmed");
  assert.equal(of({ "ai.accountant24": { minAppVersion: "1.2" } }), undefined, "not a version");
  assert.equal(of({ "ai.accountant24": { minAppVersion: 3 } }), undefined, "not a string");
  assert.equal(of({ "com.example": { minAppVersion: "1.2.3" } }), undefined, "someone else's namespace");
  assert.equal(of("nonsense"), undefined, "extensions is not even an object");
});

// --- skill frontmatter -------------------------------------------------------

test("a SKILL.md with no frontmatter has nothing to read", () => {
  assert.equal(parseFrontmatter("# Just a heading\n"), undefined);
  assert.equal(parseFrontmatter("name: loose\ndescription: no fences\n"), undefined);
});

test("frontmatter reads plain, quoted and colon-bearing values", () => {
  const fm = parseFrontmatter(
    `---\nname: my-skill\nquoted: "a \\"quoted\\" word"\nsingle: 'it''s here'\ncolon: Use when: a thing happens\n---\nBody\n`,
  );
  assert.equal(fm.name, "my-skill");
  assert.equal(fm.quoted, 'a "quoted" word');
  assert.equal(fm.single, "it's here");
  assert.equal(fm.colon, "Use when: a thing happens");
});

test("frontmatter survives Windows line endings", () => {
  const fm = parseFrontmatter("---\r\nname: my-skill\r\ndescription: Does a thing.\r\n---\r\nBody\r\n");
  assert.equal(fm.name, "my-skill");
  assert.equal(fm.description, "Does a thing.");
});

test("a folded block becomes one line, a literal block keeps its breaks", () => {
  const fm = parseFrontmatter(`---\nfolded: >\n  first line\n  second line\nliteral: |\n  first line\n  second line\n---\n`);
  assert.equal(fm.folded, "first line second line");
  assert.equal(fm.literal, "first line\nsecond line");
});

test("an indented continuation line joins the value above it", () => {
  const fm = parseFrontmatter(`---\ndescription: a long sentence\n  that carries on\nname: my-skill\n---\n`);
  assert.equal(fm.description, "a long sentence that carries on");
  assert.equal(fm.name, "my-skill", "the key after it is still read");
});

test("a key following a block scalar is still read", () => {
  const fm = parseFrontmatter(`---\ndescription: >\n  a folded description\n  over two lines\nname: my-skill\n---\n`);
  assert.equal(fm.description, "a folded description over two lines");
  assert.equal(fm.name, "my-skill");
});

// --- repositories that never list --------------------------------------------

test("forks and archived repositories are never listed", () => {
  assert.ok(excluded({ fork: true }), "a fork");
  assert.ok(excluded({ archived: true }), "archived");
  assert.equal(excluded({}), undefined, "an ordinary repository");
});

test("a private repository is not excluded, so an author can preview it", () => {
  assert.equal(excluded({ private: true }), undefined);
});

// --- indexing one repository -------------------------------------------------

test("a valid repository becomes an entry, with its skills in a stable order", async () => {
  const [item] = stubGitHub([plainRepo()]);
  const entry = await indexRepo(item, "c0ffee");
  assert.equal(entry.id, "someone/plugin");
  assert.equal(entry.manifest.name, "a-plugin");
  assert.equal(entry.manifest.description, "Does a thing.");
  assert.equal(entry.manifest.version, "1.0.0");
  assert.equal(entry.repo.name, "plugin");
  assert.equal(entry.repo.url, "https://github.com/someone/plugin");
  assert.equal(entry.repo.commit, "c0ffee");
  assert.equal(entry.repo.defaultBranch, "main");
  assert.deepEqual(
    entry.skills,
    [
      { name: "first", description: "The first skill." },
      { name: "second", description: "The second skill." },
    ],
    "sorted by name, whatever order they came back in",
  );
});

test("what the author claims and what GitHub says are kept apart", async () => {
  // Listing is automatic, so everything under `manifest` is the author writing
  // about themselves. Anyone reading an entry has to be able to tell that from
  // the repository it actually came from.
  const [item] = stubGitHub([
    plainRepo({
      full_name: "someone/plugin",
      description: "What GitHub says.",
      files: { "plugin.json": manifest({ description: "What the author says.", author: { name: "Accountant24" } }) },
    }),
  ]);
  const entry = await indexRepo(item, "c0ffee");
  assert.equal(entry.manifest.description, "What the author says.");
  assert.equal(entry.repo.description, "What GitHub says.");
  assert.equal(entry.manifest.author.name, "Accountant24", "the claim is published as made");
  assert.equal(entry.repo.owner.login, "someone", "and so is the account that really holds it");
  assert.equal(entry.manifest.repo, undefined, "nothing observed leaks into the manifest");
  assert.equal(entry.repo.version, undefined, "and nothing claimed leaks into the repo");
});

test("an entry carries the owner, down to the ids that survive a rename", async () => {
  const [item] = stubGitHub([plainRepo({ full_name: "someone/plugin", id: 42, ownerId: 7, ownerType: "User" })]);
  const { repo } = await indexRepo(item, "c0ffee");
  assert.deepEqual(repo.owner, {
    login: "someone",
    id: 7,
    type: "User",
    url: "https://github.com/someone",
    avatarUrl: "https://avatars.githubusercontent.com/u/7?v=4",
  });
  assert.equal(repo.id, 42, "the repository's own id, for a transfer or a rename");
});

test("a repository with no plugin.json at the root is not a plugin", async () => {
  const [item] = stubGitHub([plainRepo({ files: { "skills/one/SKILL.md": skillFile("one", "A skill.") } })]);
  assert.equal(await indexRepo(item, "c0ffee"), undefined);
});

test("a plugin.json that does not parse is not a plugin", async () => {
  const [item] = stubGitHub([plainRepo({ files: { "plugin.json": "{ not json" } })]);
  assert.equal(await indexRepo(item, "c0ffee"), undefined);
});

test("a plugin with no skills is still listed", async () => {
  // Skills are what a plugin holds today. A plugin made of something else --
  // pages, say -- must not fall out of the index for lack of them.
  const [item] = stubGitHub([plainRepo({ files: { "plugin.json": manifest({}) } })]);
  const entry = await indexRepo(item, "c0ffee");
  assert.equal(entry.manifest.name, "a-plugin");
  assert.deepEqual(entry.skills, []);
});

test("a broken skill is dropped without taking the plugin with it", async () => {
  const [item] = stubGitHub([
    plainRepo({
      files: {
        "plugin.json": manifest({}),
        "skills/good/SKILL.md": skillFile("good", "A good skill."),
        "skills/mismatched/SKILL.md": skillFile("something-else", "Name does not match its folder."),
        "skills/nodescription/SKILL.md": "---\nname: nodescription\n---\nBody\n",
        "skills/noframtter/SKILL.md": "Just a body, no frontmatter.\n",
        "skills/Uppercase/SKILL.md": skillFile("Uppercase", "Folder name is not allowed."),
      },
    }),
  ]);
  const entry = await indexRepo(item, "c0ffee");
  assert.deepEqual(entry.skills, [{ name: "good", description: "A good skill." }]);
});

test("a skill description too long to publish is clipped, and the skill still lists", async () => {
  const [item] = stubGitHub([
    plainRepo({
      files: { "plugin.json": manifest({}), "skills/wordy/SKILL.md": skillFile("wordy", "b".repeat(5000)) },
    }),
  ]);
  const [skill] = (await indexRepo(item, "c0ffee")).skills;
  assert.equal(skill.name, "wordy");
  assert.equal(skill.description.length, 1024);
});

test("official is true only for the accountant24 organization", async () => {
  const [ours] = stubGitHub([plainRepo({ full_name: "accountant24/skills" })]);
  assert.equal((await indexRepo(ours, "c0ffee")).official, true);

  const [theirs] = stubGitHub([plainRepo({ full_name: "accountant24-fan/skills" })]);
  assert.equal((await indexRepo(theirs, "c0ffee")).official, false);
});

test("a claimed license and a detected one are both published, neither replacing the other", async () => {
  // The index does not pick between them. A plugin whose manifest says MIT
  // while its LICENSE file is Apache-2.0 is telling you something, and folding
  // the two into one field is what threw it away.
  const [item] = stubGitHub([
    plainRepo({ license: { spdx_id: "Apache-2.0" }, files: { "plugin.json": manifest({ license: "MIT" }) } }),
  ]);
  const entry = await indexRepo(item, "c0ffee");
  assert.equal(entry.manifest.license, "MIT");
  assert.equal(entry.repo.license, "Apache-2.0");

  const [quiet] = stubGitHub([plainRepo({ license: { spdx_id: "Apache-2.0" }, files: { "plugin.json": manifest({}) } })]);
  const entryQuiet = await indexRepo(quiet, "c0ffee");
  assert.equal(entryQuiet.manifest.license, undefined, "an unstated license stays unstated");
  assert.equal(entryQuiet.repo.license, "Apache-2.0");
});

test("a license GitHub could not place is not published as one", async () => {
  // NOASSERTION is what the API says when it found a LICENSE it cannot name.
  // Passing it through would put a string that is not an SPDX id where every
  // consumer expects one.
  const [item] = stubGitHub([plainRepo({ license: { spdx_id: "NOASSERTION" } })]);
  assert.equal((await indexRepo(item, "c0ffee")).repo.license, undefined);
});

// --- finding the repositories ------------------------------------------------

test("every page of search results is kept, once each", async () => {
  // A repository dropped here never reaches the index, and nothing says so.
  const many = Array.from({ length: 250 }, (_, i) => plainRepo({ full_name: `owner/plugin-${i}` }));
  stubGitHub(many);
  const found = await searchTopic();
  assert.equal(found.length, 250, "pagination continues past the first page");
  assert.equal(new Set(found.map((r) => r.full_name)).size, 250, "no repository counted twice");
});

test("a search that fits on one page stops after it", async () => {
  stubGitHub([plainRepo({ full_name: "owner/only" })]);
  assert.deepEqual((await searchTopic()).map((r) => r.full_name), ["owner/only"]);
});

// --- collecting across repositories ------------------------------------------

test("entries come out sorted by id", async () => {
  const items = stubGitHub([
    plainRepo({ full_name: "zed/plugin" }),
    plainRepo({ full_name: "alice/plugin" }),
    plainRepo({ full_name: "mike/plugin" }),
  ]);
  const plugins = await collect(items);
  assert.deepEqual(
    plugins.map((p) => p.id),
    ["alice/plugin", "mike/plugin", "zed/plugin"],
  );
});

test("a blocklisted repository is never indexed, whatever its case", async () => {
  const items = stubGitHub([plainRepo({ full_name: "Someone/Plugin" })]);
  assert.deepEqual(await collect(items, new Set(["someone/plugin"])), []);
});

test("the blocklist in this repository is readable, and every entry is usable", () => {
  // The one file here a human edits by hand, so it is the one a typo reaches.
  // A broken one throws on every scheduled run and the index stops updating.
  const blocklist = JSON.parse(readFileSync(new URL("../blocklist.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(blocklist), "blocklist.json holds an array");
  for (const entry of blocklist) {
    assert.match(entry.repo ?? "", /^[^/\s]+\/[^/\s]+$/, `${entry.repo} should read owner/name`);
    assert.ok(entry.reason, `${entry.repo} should say why it is blocked`);
  }
});

test("a fork or an archived repository is skipped even when asked for directly", async () => {
  // --repo has to give the same answer the index would. Telling an author their
  // fork looks fine, when it will never be listed, is worse than saying nothing.
  const forks = stubGitHub([plainRepo({ fork: true })]);
  assert.deepEqual(await collect(forks), []);

  const archived = stubGitHub([plainRepo({ archived: true })]);
  assert.deepEqual(await collect(archived), []);
});

test("a repository whose default branch cannot be resolved is skipped", async () => {
  const items = stubGitHub([plainRepo({ default_branch: "trunk" })]);
  const [item] = items;
  item.default_branch = "main"; // the branch the ref lookup will ask for, and miss
  assert.deepEqual(await collect([item]), []);
});

// --- the command line --------------------------------------------------------

test("--repo without a repository is an error, not a full index run", async () => {
  // A full run writes marketplace.json into the working directory. Someone who
  // typed the command from the README and left off the name must not get that.
  stubGitHub([]);
  await assert.rejects(() => main(["--repo"]), /--repo/);
});

test("--repo prints the entry and writes nothing", async () => {
  stubGitHub([plainRepo()]);
  const printed = [];
  console.log = (line) => printed.push(line);
  try {
    await main(["--repo", "someone/plugin"]);
  } finally {
    console.log = () => {};
  }
  const entry = JSON.parse(printed.join("\n"));
  assert.equal(entry.id, "someone/plugin");
  assert.equal(entry.skills.length, 2);
});

// --- messages someone can act on ---------------------------------------------
//
// Every one of these is read by a plugin author who cannot see the code, so it
// has to name the problem and, where there is one, the way out of it.

test("a repository nobody can see suggests both reasons it might not be there", async () => {
  stubGitHub([]);
  await assert.rejects(() => main(["--repo", "nobody/nothing"]), /spelling/, "a typo");
  await assert.rejects(() => main(["--repo", "nobody/nothing"]), /private/, "or it is private");
  await assert.rejects(() => main(["--repo", "nobody/nothing"]), /GITHUB_TOKEN/, "and what to do about that");
});

test("a rejected token says how to get a working one", async () => {
  // Not `gh auth token`, which would hand back the same rejected token.
  globalThis.fetch = async () => response({ status: 401 });
  await assert.rejects(() => main(["--repo", "someone/plugin"]), /gh auth login/);
});

test("running out of rate limit says so, rather than blaming the repository", async () => {
  globalThis.fetch = async () => response({ status: 403, headers: { "x-ratelimit-remaining": "0" } });
  await assert.rejects(() => main(["--repo", "someone/plugin"]), /rate limit/);
});

test("a refusal that is not a rate limit points at the token instead", async () => {
  globalThis.fetch = async () => response({ status: 403, headers: { "x-ratelimit-remaining": "57" } });
  await assert.rejects(() => main(["--repo", "someone/plugin"]), /private/);
});

test("GitHub being down is not reported as the author's mistake", async () => {
  globalThis.fetch = async () => response({ status: 502 });
  await assert.rejects(() => main(["--repo", "someone/plugin"]), /GitHub is having trouble/);
});

test("being a fork or archived comes with the way out of it", () => {
  assert.match(excluded({ fork: true }), /repository of its own/);
  assert.match(excluded({ archived: true }), /Unarchive/);
});

test("a manifest with no name is shown what one looks like", () => {
  assert.match(parseManifest('{"description":"no name here"}').error, /"name": "my-plugin"/);
});

test("a manifest name that breaks a rule is told which rule", () => {
  assert.match(parseManifest('{"name":"My-Plugin"}').error, /lowercase/);
  assert.match(parseManifest('{"name":"my--plugin"}').error, /two hyphens/);
  assert.match(parseManifest('{"name":"-my-plugin"}').error, /hyphen/);
});
