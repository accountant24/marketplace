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

## Plugin requirements

`plugin.json` at the repository root, in the [Agent Plugins](https://agent-plugins.org) manifest format:

| Field                                         | Required | Validation                                                                                                                  | What it is                                                                                                               |
| --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `$schema`                                     | **yes**  | `https://agent-plugins.org/schemas/<version>/plugin.schema.json`                                                            | The manifest format this file is written in. Any version is accepted.                                                    |
| `name`                                        | **yes**  | String, 1–64 characters of lowercase letters, numbers and hyphens; not starting or ending with a hyphen, never two in a row | Identifies the plugin.                                                                                                   |
| `version`                                     | no       | String, up to 64 characters                                                                                                 | The plugin's own version.                                                                                                |
| `description`                                 | no       | String, clipped at 1024 characters                                                                                          | What the plugin does. Shown in the app.                                                                                  |
| `author`                                      | no       | Object                                                                                                                      | Who published the plugin, as they describe themselves. Nobody checks it. Left out when none of its three fields survive. |
| `author.name`                                 | no       | String, up to 128 characters                                                                                                | The name to show.                                                                                                        |
| `author.email`                                | no       | String, up to 254 characters                                                                                                | Where to reach them.                                                                                                     |
| `author.url`                                  | no       | String, up to 512 characters                                                                                                | Their own site.                                                                                                          |
| `homepage`                                    | no       | String, up to 512 characters                                                                                                | Where to read more.                                                                                                      |
| `repository`                                  | no       | String                                                                                                                      | Allowed by the format. Not published: the index reports the repository it actually read.                                 |
| `license`                                     | no       | String, up to 64 characters                                                                                                 | The license as claimed. The index also publishes the one GitHub detects.                                                 |
| `keywords`                                    | no       | Array of strings, first 20 kept, each up to 64 characters                                                                   | Free-form tags.                                                                                                          |
| `extensions`                                  | no       | Object                                                                                                                      | Data meant for one particular app. The format gives its contents no meaning.                                             |
| `extensions["ai.accountant24"].minAppVersion` | no       | String reading like `1.2.3`                                                                                                 | The oldest Accountant24 the plugin runs on. The only extension the index reads.                                          |

No other top-level key. The format closes the object, so anything else keeps the plugin off the index — app-specific data belongs under `extensions`.

A missing `$schema` or `name` is not listed at all. Every other field is dropped when it has the wrong type or runs past its limit, which never costs a plugin its listing. Descriptions are clipped rather than dropped, since half of one still reads.

Each skill is `skills/<name>/SKILL.md`, up to 50 per plugin, opening with a `---` frontmatter block:

| Field         | Required | Validation                                                                   | What it is                                                                    |
| ------------- | -------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `name`        | **yes**  | Must equal the folder name: lowercase letters, numbers and hyphens, up to 64 | Identifies the skill.                                                         |
| `description` | **yes**  | Non-empty string, clipped at 1024 characters                                 | What the skill does and when to use it. Both the app and the agent read this. |

A skill that breaks either rule is left out; the plugin itself still lists.

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
