# Accountant24 Plugin Marketplace

The index of plugins for [Accountant24](https://accountant24.ai).

Every public repository tagged with the topic `accountant24-plugin` that holds a valid plugin is listed in [`marketplace.json`](marketplace.json).

> [!WARNING]
> Listing is automatic. Being here means the author tagged their own repository — nobody at Accountant24 reviewed the plugin. Plugins can read and change your financial data and can run software on your computer, so check the source repository before you install one.

## Get your plugin listed

1. Put your plugin in a public GitHub repository, with `plugin.json` at the root. See [Create a plugin](https://accountant24.ai/docs/create-a-plugin) for the format, and [accountant24/skills](https://github.com/accountant24/skills) for a complete example.
2. Add the topic `accountant24-plugin` to the repository.
3. Wait for the next index run. The index refreshes every 30 minutes.

Forks and archived repositories are never listed.

## Check your plugin

To see the entry the index would publish for a repository, or the reason it skipped something:

```sh
curl -fsSL https://raw.githubusercontent.com/accountant24/marketplace/main/scripts/index.mjs | node - --repo owner/name
```

Needs Node 22.7 or newer. Writes nothing. Add `GITHUB_TOKEN=$(gh auth token)` in front if you hit GitHub's rate limit, or if your repository is still private.

## Moderation

[`blocklist.json`](blocklist.json) lists repositories that are never indexed. To report a plugin, open an issue or a pull request against that file.

## License

[Apache-2.0](LICENSE)
