# Personal Pi extensions

Four extensions for the [Pi coding agent](https://pi.dev/), tested with Pi 1.6.0.

## Install

With Pi and Git installed, run this from any directory. No GitHub login is needed:

```sh
pi install git:github.com/hegyibalint/pi-extensions
```

Restart Pi or run `/reload` after installation. To pull updates or uninstall:

```sh
pi update git:github.com/hegyibalint/pi-extensions
pi remove git:github.com/hegyibalint/pi-extensions
```

If you already have loose copies of these extensions in `~/.pi/agent/extensions/`, move those copies outside the extension directory before installing the package to avoid loading them twice.

## Extensions

| Extension | What it does |
| --- | --- |
| `ide-context` | Pulls the active file, cursor, selection coordinates, and open tabs from the VS Code window where Pi was started. `/ide` previews the context. No Codex required. |
| `notification` | `/notification on` enables macOS desktop notifications for completed turns; `/notification off` disables them. Off by default. |
| `statusbar` | Shows context usage, token counts, cost, Git branch, and provider quota when available. Toggle with `/statusbar`. |
| `web-search` | Adds `web_search` and `codex_standalone_web` using Pi’s existing OpenAI credentials and an available OpenAI model with web search support. |

Installing does not require provider credentials. For features that use OpenAI or Anthropic, use `/login` in Pi if you aren't already signed in. This repo does not include Pi settings, credentials, or session data.

## VS Code context setup

The Pi client is already included in the install above. To enable the editor side, download the [Pi IDE Context VSIX](https://github.com/hegyibalint/pi-ide-context/releases/latest) and install it in VS Code via **Extensions: Install from VSIX…**. Open a new integrated terminal, start Pi, and run `/ide`. Existing shells need to be reopened; external terminals work as usual.

Selected text is off by default. Context attached to a prompt is saved in the Pi session and can be sent to the model provider. Pi shows `↳ IDE context attached` above the prompt in the terminal UI. Run `/ide` to preview the current snapshot or `/ide off` to pause automatic attachment for the session. If you installed the old standalone Pi companion, remove it to avoid duplicate context: `pi remove git:github.com/hegyibalint/pi-ide-context@v0.1.0` (use the source shown by `pi list` if it differs).

## Development

Use Node.js 22.19 or newer for the tests:

```sh
npm ci
npm test
```

To try a checkout in Pi, run `pi install /absolute/path/to/pi-extensions`. Use either the checkout or the GitHub package, not both. Pi supplies the runtime peer dependencies; the pinned dev dependencies are for tests.
