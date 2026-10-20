# OpenCode Configuration

[![Last commit](https://img.shields.io/github/last-commit/countzero/ai_opencode)](https://github.com/countzero/ai_opencode/commits/main) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![GitHub Sponsors](https://img.shields.io/github/sponsors/countzero?label=Sponsor&logo=GitHub)](https://github.com/sponsors/countzero) [![Ko-fi](https://img.shields.io/badge/Ko--fi-Tip-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/finnkumkar)

My global configuration for [OpenCode](https://opencode.ai) on Windows, published so others can take single plugins and skills. The repository is the `~/.config/opencode` directory itself, so OpenCode reads it in place.

## Contents

| Path                            | What it does                                        | Runs on |
| ------------------------------- | --------------------------------------------------- | ------- |
| `plugins/todo-state.js`         | Keeps a todo list for multi-step work in view       | any     |
| `plugins/llama-limits.js`       | Fills llama-server and Strata providers             | any     |
| `plugins/background-guard.js`   | Limits background subagents to capped explore tasks | any     |
| `plugins/local-only-mail.js`    | Keeps Thunderbird mail on local models              | any     |
| `scripts/opencode.ps1`          | Gives every OpenCode window its own Chrome profile  | Windows |
| `scripts/migrate.ps1`           | Moves a machine from OpenCode 1.x to 2.0            | Windows |
| `tui-plugins/slot-title/`       | Shows the Chrome slot in the terminal title         | Windows |
| `tui-plugins/agent-refresh/`    | Refreshes the agent list after a plugin reload      | any     |
| `.opencode/skills/plan-review/` | Second-pass design review of a plan                 | any     |
| `.opencode/skills/trim-prose/`  | Tightens the comments and docs a branch changes     | bash    |
| `opencode.json`                 | Models, agents, permissions, MCP servers, providers | Windows |
| `cli.json`                      | Theme and the TUI plugins                           | any     |
| `.opencode/AGENTS.md`           | Rules for sessions inside this repository           | any     |

## Reuse a Plugin or Skill

Every plugin states how to install it in its header comment. A skill directory goes into `~/.config/opencode/skills/` to load in every project, or into a project's `.opencode/skills/` to load only there; here the skills sit in `.opencode/skills/`, so they load only when OpenCode runs inside this directory.

The plugins are tested against OpenCode 2.1.0, which `"update": "disable"` keeps in place; a newer 2.x release can break them. A machine still on 1.x follows [`MIGRATION.md`](./MIGRATION.md).

## Install the Whole Configuration

This replaces your own configuration and assumes my setup: Windows, the MCP servers in `opencode.json`, and llama-server hosts on my network.

### 1. Install Prerequisites

Download and install the latest versions:

* [Git](https://git-scm.com/download)
* [Node.js LTS](https://nodejs.org/en/download), installed to `C:\Program Files\nodejs`, whose `npx` starts the `chrome-devtools` MCP server
* OpenCode 2, through npm: `npm -g install @opencode/cli@2`; the `@2` keeps a future major release from arriving unasked
* [Chromium](https://www.chromium.org/getting-involved/download-chromium/), installed per user to `C:\Users\<name>\AppData\Local\Chromium`

### 2. Clone the repository from GitHub

Move an existing configuration aside, then clone the repository into its place:

```PowerShell
Rename-Item "$HOME\.config\opencode" "opencode.backup" -ErrorAction SilentlyContinue
git clone https://github.com/countzero/ai_opencode.git "$HOME\.config\opencode"
```

### 3. Add the secrets

Secrets never enter the repository. `opencode.json` reads them from files under `~/.secrets` via `{file:…}`:

| File                         | Used by                                      |
| ---------------------------- | -------------------------------------------- |
| `~/.secrets/windows-mcp-key` | Bearer token of the `windows-mcp` MCP server |

Create each file with the value as its only content:

```PowerShell
New-Item -ItemType Directory -Force "$HOME\.secrets" | Out-Null
Set-Content -NoNewline "$HOME\.secrets\windows-mcp-key" "<token>"
```

A missing file leaves its value empty and logs a warning; `windows-mcp` then fails to authenticate.

### 4. Disable the service

```PowerShell
opencode service set disabled true
```

By default all OpenCode windows share one background service, and its MCP servers would hand every window the same Chrome slot. Without the service, each window starts a private server that inherits the window's environment and ends with it. This costs `/pair` and attaching a second client to a running session.

### 5. Add the launcher

Add these lines to the PowerShell profile (`$PROFILE.CurrentUserAllHosts`), so `opencode` runs through the launcher that claims a Chrome slot, and `oc` is short for it:

```PowerShell
function opencode { & "$HOME\.config\opencode\scripts\opencode.ps1" @args }
Set-Alias -Name oc -Value opencode -Option AllScope
```

### 6. Install the plugin

```PowerShell
opencode plugin add opencode-claude-auth@3.0.0
```

OpenCode installs the plugins named in `opencode.json` into `~/.cache/opencode/npm` on its own, but on Windows the first install of this one takes about a minute, and OpenCode gives plugins 5 s to activate: every start fails with "Location plugins did not finish activating" and abandons the install halfway. `plugin add` runs the same install in the foreground; once it is cached, startup takes a second. Repeat it after changing the plugin's version in `opencode.json`.

### 7. Start OpenCode

Start OpenCode in any project directory:

```PowerShell
opencode
```

OpenCode writes `service.json` into this directory; the `.gitignore` keeps it out.

On the first start, log in once:

1. `/connect`, then **Anthropic**, then **Import Claude Code subscription**. This reads `~/.claude/.credentials.json`, so Claude Code must be logged in.
2. `opencode mcp auth atlassian` in a shell, for the Atlassian MCP server.

## Usage

### Chrome profile slots

The launcher claims the lowest free slot `N` for its window and runs the `chrome-devtools` MCP server on the profile `~/.cache/chrome-devtools-mcp/opencode-profile-N`. Parallel instances therefore never share a browser, and a slot keeps its logins between sessions. The launcher passes the slot on as `$env:CHROME_SLOT`, which `opencode.json` reads. The window title shows the slot as a `[N]` prefix, and every agent shell sees it as `$env:CHROME_SLOT`.

To prefer a specific slot, set it before starting:

```PowerShell
$env:CHROME_SLOT = '3'; opencode
```

> [!NOTE]
> The preference is honored only while the slot is free; a taken slot falls back to the lowest free one. A slot is released when its window ends, however it ends. An OpenCode started without the launcher, from `cmd` or inside an agent shell, gets no slot of its own.

The mechanics are the header comments of [`scripts/opencode.ps1`](./scripts/opencode.ps1) and [`tui-plugins/slot-title/`](./tui-plugins/slot-title/).

### Local models

A `llama.cpp@…` or `strata@…` provider in `opencode.json` carries only its `baseURL`. At startup, [`plugins/llama-limits.js`](./plugins/llama-limits.js) asks each llama-server router for the models of its preset file, and each [Strata](https://github.com/Niko1221/Strata) server for its loaded model, and adds them with their context limit and input modalities. A Strata model also gets the reasoning variants `none`, `low`, `medium` and `high`, and an output limit of 32,000 tokens, because Strata refuses a request whose prompt plus output passes the context. A server that does not answer within a second shows no models.

> [!NOTE]
> The list is read at startup: after starting a server or editing a preset, restart OpenCode. `opencode run` checks its model before the list arrives and reports "Model unavailable"; the TUI is not affected.

### Mail

The `mail` agent reads Thunderbird mail, calendars and contacts on a local model and changes nothing. It talks to the [Commonpost MCP add-on](https://github.com/commonpost/thunderbird-mcp) through the `commonpost-mail` server, which is off until connected in `/mcps`.

Setup, once:

1. Download `commonpost-mcp-v<version>.xpi` and `mcp-bridge.cjs` from the [latest release](https://github.com/commonpost/thunderbird-mcp/releases/latest) into `~/commonpost-mcp/`, and check both with `gh attestation verify <file> --repo commonpost/thunderbird-mcp`.
2. In Thunderbird: Tools > Add-ons and Themes > gear menu > Install Add-on From File, pick the `.xpi`, restart Thunderbird.
3. In the add-on's options page, choose the accounts the assistant may read, turn off every tool that writes, and keep **Block skipReview** on.

Use: connect `commonpost-mail` in `/mcps` and pick a local model. While it is connected, the agent list offers only `mail`, and new sessions start in it; disconnecting it brings back `build` and `plan`. A session already open keeps its agent. [`tui-plugins/agent-refresh`](./tui-plugins/agent-refresh/tui.js) makes the TUI pick up the switch without a restart.

[`plugins/local-only-mail.js`](./plugins/local-only-mail.js) keeps the mail local:

* The mail tools exist only in the `mail` agent, and only for a `llama.cpp@…` or `strata@…` model; the agent refuses to run on any other.
* A session that has touched mail never sends its history elsewhere: switching it to another agent on a cloud model, or compacting it there, fails with an error that says why. Its title is set without a model. Forks and subagent sessions started from it inherit this.
* `saveAttachments` is refused, so reading a message writes no files.

> [!NOTE]
> The bridge does not update itself. When the add-on's options page (section Bridge) recommends a newer one, replace `~/commonpost-mcp/mcp-bridge.cjs` and reconnect the server.

### Background subagents

The agent can start a subagent in the background and keep talking; its result arrives as a separate message when it finishes. **Ctrl+B** moves a running foreground subagent to the background. **Ctrl+D** on a running subagent in the composer's subagent list interrupts just that one; **Esc** interrupts the session.

[`plugins/background-guard.js`](./plugins/background-guard.js) allows background tasks only for the read-only `explore` agent and at most 20 running per session; a background call for another agent or beyond the cap fails with an error that tells the agent to run it in the foreground. It also asks the agent to announce what it starts and to report once all results are in.

> [!NOTE]
> Browser work stays in the foreground: one OpenCode window has one Chrome profile, and parallel browser tasks would collide on it.

### Change the configuration

Edit the files in place. OpenCode reloads the configuration and plugins when they change and keeps the last good version if a reload fails; restart it if a change does not show (#56421). Machine-specific values go through `{env:…}` or `{file:…}` rather than into the file, so the same `opencode.json` works on every machine; paths use `C:/Users/{env:USERNAME}/…`, because the backslashes in `USERPROFILE` would break the JSON.

## License

[MIT](./LICENSE)

## Support

If a plugin or skill here saves you a hassle, consider supporting future work:

- [GitHub Sponsors](https://github.com/sponsors/countzero): recurring or one-time.
- [Ko-fi](https://ko-fi.com/finnkumkar): one-time tip, no signup required.

<a href="https://ko-fi.com/finnkumkar"><img src="https://storage.ko-fi.com/cdn/kofi2.png?v=6" alt="Support on Ko-fi" width="180"></a>
