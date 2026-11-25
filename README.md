# Personal Pi extensions

Four extensions for the [Pi coding agent](https://pi.dev/), tested with Pi 1.6.0.

## Install on another machine

With Pi installed and Git authenticated to access this private GitHub repository:

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
| `ide-context` | Uses local Codex IDE IPC, when available, to include the active file, selection, and open tabs in Pi prompts. `/ide` shows what Pi can see. |
| `notification` | `/notification on` enables macOS desktop notifications for completed turns; `/notification off` disables them. Off by default. |
| `statusbar` | Shows context usage, token counts, cost, Git branch, and provider quota when available. Toggle with `/statusbar`. |
| `web-search` | Adds `web_search` and `codex_standalone_web` using Pi’s existing OpenAI credentials and an available OpenAI model with web search support. |

Sign in to the relevant providers on each machine; this repo does not include Pi settings, credentials, or session data.

## Development

Use Node.js 22.19 or newer for the tests:

```sh
npm ci
npm test
```

To try a checkout in Pi, run `pi install /absolute/path/to/pi-extensions`. Use either the checkout or the GitHub package, not both. Pi supplies the runtime peer dependencies; the pinned dev dependencies are for tests.
