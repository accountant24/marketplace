# Accountant24 plugin marketplace

The index of plugins for [Accountant24](https://accountant24.ai), the local-first AI agent for personal finance. It is built automatically from GitHub: every public repository tagged with the topic `accountant24-plugin` that holds a valid plugin is listed here, in [`marketplace.json`](marketplace.json). No submission form, no review queue.

Listing is automatic and unreviewed. A plugin here tagged itself; it was not vetted by Accountant24. Plugins can read and change your financial data and can run software on your computer, so check the source repository before you install one.

## Get your plugin listed

1. Put your plugin in a public GitHub repository, with `plugin.json` at the root. See [Create a plugin](https://accountant24.ai/docs/create-a-plugin) for the format, and [accountant24/skills](https://github.com/accountant24/skills) for a complete example.
2. Add the topic `accountant24-plugin` to the repository (the gear next to About on the repository page).
3. Wait for the next index run. The index refreshes every 30 minutes.

Forks, archived repositories, and repositories without a valid `plugin.json` are not listed. To see what the index makes of your repository — the entry it would publish, or the reason it skipped something — run it yourself, before or after you add the topic:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/index.mjs --repo owner/name
```

## What the index records

For each plugin: the manifest fields (`name`, `description`, `version`, `author`, `license`, `homepage`, `keywords`, `minAppVersion`), where it lives (`repo`, `defaultBranch`, and the exact `commit` that was indexed), its skills (name and description from each `SKILL.md`), and `official`, which is `true` only for repositories owned by the `accountant24` organization. Entries are sorted by `id`, the key to store a plugin under. The file changes only when a plugin does, so its git history is the changelog.

The index is served at `https://raw.githubusercontent.com/accountant24/marketplace/main/marketplace.json`.

## Moderation

[`blocklist.json`](blocklist.json) lists repositories that are never indexed, with a reason. To report a plugin, open an issue or a pull request against that file.

## How it runs

[`scripts/index.mjs`](scripts/index.mjs) is a zero-dependency Node 22 script that rebuilds the index from scratch on every run — nothing cached, nothing retried. [`.github/workflows/index.yml`](.github/workflows/index.yml) runs it every 30 minutes with the workflow's own `GITHUB_TOKEN` and commits `marketplace.json` when it changed; a run that fails costs nothing, because the next one starts over.

The script checks only what it needs to list a plugin: a `plugin.json` with a usable name. It records the skills a plugin holds but does not require any, and it ignores manifest fields it does not recognize — a plugin built out of something newer than the indexer should not quietly fall out of the index. The desktop app validates the manifest again at install time.

## License

Apache-2.0
