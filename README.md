# Accountant24 plugin marketplace

The index of plugins for [Accountant24](https://accountant24.ai), the local-first AI agent for personal finance. It is built automatically from GitHub: every public repository tagged with the topic `accountant24-plugin` that holds a valid plugin is listed here, in [`marketplace.json`](marketplace.json).

Listing is automatic and unreviewed. A plugin here tagged itself; it was not vetted by Accountant24. Plugins can read and change your financial data and can run software on your computer, so check the source repository before you install one.

## Get your plugin listed

1. Put your plugin in a public GitHub repository, with `plugin.json` at the root. See [Create a plugin](https://accountant24.ai/docs/create-a-plugin) for the format, and [accountant24/skills](https://github.com/accountant24/skills) for a complete example.
2. Add the topic `accountant24-plugin` to the repository (the gear next to About on the repository page).
3. Wait for the next index run. The index refreshes every 30 minutes.

Forks, archived repositories, and repositories without a valid `plugin.json` are not listed.

## Check your plugin

Run the indexer against a repository to see the entry it would publish, or the reason it skipped something. Worth doing before you add the topic, and the first thing to try if your plugin has not shown up. Nothing to clone or install; Node 22.7 or newer is all it needs:

```sh
curl -fsSL https://raw.githubusercontent.com/accountant24/marketplace/main/scripts/index.mjs | node - --repo owner/name
```

It writes nothing. Add `GITHUB_TOKEN=$(gh auth token)` in front if you hit GitHub's rate limit, or if your repository is still private.

## What the index records

Everything in your `plugin.json`, the repository and the exact commit that was indexed, the name and description of each skill, and `official`, which is `true` only for repositories owned by the `accountant24` organization. Each entry is keyed by `id`, the value to store a plugin under.

The index is served at `https://raw.githubusercontent.com/accountant24/marketplace/main/marketplace.json`.

## Moderation

[`blocklist.json`](blocklist.json) lists repositories that are never indexed. Each entry names the repository and why it is blocked:

```json
[{ "repo": "owner/name", "reason": "why it is blocked" }]
```

Only `repo` is read by the indexer; `reason` is there for whoever reads the file next. To report a plugin, open an issue or a pull request against that file.

## How it runs

[`scripts/index.mjs`](scripts/index.mjs) is a zero-dependency Node script that rebuilds the index from scratch on every run, so a run that fails costs nothing — the next one starts over. [`.github/workflows/index.yml`](.github/workflows/index.yml) runs it every 30 minutes with the workflow's own `GITHUB_TOKEN` and commits `marketplace.json` when it changed.

It checks only what it needs to list a plugin, and ignores what it does not recognize rather than rejecting it. The desktop app validates the manifest again at install time.

## License

Apache-2.0
