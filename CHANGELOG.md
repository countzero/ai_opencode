# Changelog

This changelog follows [Common Changelog](https://common-changelog.org) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-20

_This version runs on OpenCode 2.1 only. Follow README.md → *Install the Whole Configuration* from step 1: install `@opencode/cli@2`, disable the service, add the launcher to the PowerShell profile and run `opencode plugin add opencode-claude-auth@3.0.0`. A machine on OpenCode 1.x stays on the tag `v1.19.3-final`._

### Changed

- **Breaking:** port the configuration to OpenCode 2: the plugins use the `{ id, setup }` API, and the TUI settings move from `tui.json` to `cli.json` ([`1c4e7c8`](https://github.com/countzero/ai_opencode/commit/1c4e7c8))
- **Breaking:** claim the Chrome slot in the launcher `scripts/opencode.ps1` instead of `plugins/chrome-slot.js`, and show it in the terminal title through `tui-plugins/slot-title/` ([`1c4e7c8`](https://github.com/countzero/ai_opencode/commit/1c4e7c8))
- **Breaking:** rename the repository to `ai_opencode` ([`6fd4027`](https://github.com/countzero/ai_opencode/commit/6fd4027))
- Move agents, permissions and MCP servers in `opencode.json` to the V2 layout ([`4d0dda9`](https://github.com/countzero/ai_opencode/commit/4d0dda9), [`85744b1`](https://github.com/countzero/ai_opencode/commit/85744b1))
- Keep the todo list in view again with `plugins/todo-state.js` on OpenCode 2.1's `todowrite`, and require a list for any task of more than one step ([`0fdb8a0`](https://github.com/countzero/ai_opencode/commit/0fdb8a0), [`ceaaf91`](https://github.com/countzero/ai_opencode/commit/ceaaf91))
- Cycle agents with Tab as well as Shift+Tab ([`81e8f08`](https://github.com/countzero/ai_opencode/commit/81e8f08))
- Turn off the TUI tab strip, so each window keeps one session ([`0bf5a40`](https://github.com/countzero/ai_opencode/commit/0bf5a40))
- Run the `blender` MCP server on Blender's own `blmcp` ([`05a076f`](https://github.com/countzero/ai_opencode/commit/05a076f))

### Added

- Add the read-only `mail` agent for Thunderbird through the Commonpost MCP add-on, with `plugins/local-only-mail.js` keeping mail on local models and offering only `mail` while `commonpost-mail` is connected ([`4d0dda9`](https://github.com/countzero/ai_opencode/commit/4d0dda9), [`29aafbd`](https://github.com/countzero/ai_opencode/commit/29aafbd), [`8187fd6`](https://github.com/countzero/ai_opencode/commit/8187fd6), [`93d1a63`](https://github.com/countzero/ai_opencode/commit/93d1a63))
- Add `tui-plugins/agent-refresh/`, which refreshes the agent list after a plugin reload without a restart ([`f774594`](https://github.com/countzero/ai_opencode/commit/f774594))
- Detect Strata servers in `plugins/llama-limits.js` with their loaded model's context, image input and reasoning variants, and add the `strata@Laptop-Finn` provider ([`eb4f26d`](https://github.com/countzero/ai_opencode/commit/eb4f26d))

[2.0.0]: https://github.com/countzero/ai_opencode/releases/tag/v2.0.0
