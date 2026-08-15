# Accountant24 plugin marketplace

The index of plugins for [Accountant24](https://accountant24.ai), the local-first AI agent for personal finance. It is built automatically from GitHub: every public repository tagged with the topic `accountant24-plugin` that holds a valid plugin is listed here, in [`marketplace.json`](marketplace.json). No submission form, no review queue.

Listing is automatic and unreviewed. A plugin here tagged itself; it was not vetted by Accountant24. Plugins can read and change your financial data and can run software on your computer, so check the source repository before you install one.

## Get your plugin listed

1. Put your plugin in a public GitHub repository, with `plugin.json` at the root (or in a subfolder, up to two levels deep, if you keep several plugins in one repository). See [Create a plugin](https://accountant24.ai/docs/create-a-plugin) for the format, and [accountant24/skills](https://github.com/accountant24/skills) for a complete example.
2. Add the topic `accountant24-plugin` to the repository (the gear next to About on the repository page).
3. Wait for the next index run. The index refreshes every 30 minutes and rescans a repository whenever its default branch moves.

Forks, archived repositories, and repositories without a valid `plugin.json` and at least one valid `skills/<name>/SKILL.md` are not listed. If your repository carries the topic but does not appear, look it up in [`rejected.json`](rejected.json): every skipped repository, manifest, and skill is there with the reason. You can also run the indexer against your own repository before adding the topic:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/index.mjs --repo owner/name
```

## What the index records

For each plugin: the manifest fields (`name`, `description`, `version`, `author`, `license`, `homepage`, `keywords`, `minAppVersion`), where it lives (`repo`, `subpath`, `defaultBranch`, and the exact `commit` that was indexed), repository signals (`stars`, `pushedAt`), its skills (name and description from each `SKILL.md`), and `official`, which is `true` only for repositories owned by the `accountant24` organization. Entries are sorted by `id` (`owner/repo`, plus the subfolder for plugins in subfolders). `updatedAt` is when the list last changed.

The index is served at `https://raw.githubusercontent.com/accountant24/marketplace/main/marketplace.json`.

## Moderation

[`blocklist.json`](blocklist.json) lists repositories that are never indexed, with a reason. To report a plugin, open an issue or a pull request against that file.

## Plugins

<!-- plugins:start -->
_No plugins indexed yet._
<!-- plugins:end -->

## How it runs

[`scripts/index.mjs`](scripts/index.mjs) is a zero-dependency Node 22 script. [`.github/workflows/index.yml`](.github/workflows/index.yml) runs it every 30 minutes with the workflow's own `GITHUB_TOKEN`, then commits `marketplace.json`, `rejected.json`, and the table above when they changed. Validation mirrors what the desktop app checks at install time; the app validates again on install.

## License

Apache-2.0
