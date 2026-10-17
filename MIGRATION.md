# Migrate a Machine from OpenCode 1.x to 2.0

For a Windows machine that runs this configuration on OpenCode 1.x. Tested with `@opencode/cli` 2.0.32 and `opencode-claude-auth@3.0.0`. [`scripts/migrate.ps1`](./scripts/migrate.ps1) does the work; its header lists what it changes and why.

There is no in-between state: 1.x and 2.0 install the same `opencode` command, and no version of the Claude login plugin serves both.

## 1. Run the script

Close every OpenCode window, then in a new pwsh window:

```PowerShell
git -C "$HOME\.config\opencode" pull
& "$HOME\.config\opencode\scripts\migrate.ps1"
```

It backs up `~\.local\share\opencode` to `~\.local\share\opencode-1.x-backup`; `-BackupDir <dir>` puts the copy on another drive. After a failure, fix the cause and run it again: finished steps are skipped.

## 2. Log in

Open a new terminal, so the profile's launcher function loads, then:

1. Start `opencode`. Sessions from 1.x appear once a background job has copied them; a large database takes a while.
2. `/connect`, then **Anthropic**, then **Import Claude Code subscription**. It reads `~/.claude/.credentials.json`, so Claude Code must be logged in.
3. `opencode mcp auth atlassian` in a shell; 2.0 does not take over the 1.x MCP logins.

## 3. Verify

The script has checked the version, the service and that every plugin activates. Left to check by hand:

| Check                         | Expected                                                       |
| ----------------------------- | -------------------------------------------------------------- |
| Terminal title                | `[N] OpenCode`; a second window shows another `N`              |
| `$env:CHROME_SLOT` in a shell | The same `N`                                                   |
| `/models`                     | Claude models, and the presets of every reachable llama-server |
| `opencode mcp list`           | `chrome-devtools`, `chrome-android`, `blender` connect         |

## 4. Projects

2.0 changes three things outside this repository:

- **`CLAUDE.md`** no longer loads. In a project whose only rules file it is, rename it to `AGENTS.md`; Claude Code reads that too.
- **1.x plugins** in a project's `.opencode/plugins/` fail to load. A plugin that only sets `SESSION_ID` in shells can go: 2.0 sets `OPENCODE_SESSION_ID` itself. Others need a port to the `{ id, setup(ctx) }` API.
- **`edit` rules** with relative paths outside the project (`"../*": "deny"`) never match: 2.0 matches paths outside the project as absolute paths, such as `"D:/Arbeit/**": "deny"`.

## Update later

```
cmd /c opencode service stop 2>nul & npm -g install @opencode/cli@2 || pause
```

After raising a plugin's version in `opencode.json`, run `opencode plugin add <plugin>@<version>` before the next start: left to startup, the install can outlast the 5 s plugins get to activate.

## Roll back

Close every OpenCode window, then:

```PowerShell
& "$HOME\.config\opencode\scripts\migrate.ps1" -Rollback
```

Pass the same `-BackupDir` as the migration. The 2.0 data is moved aside, not deleted, and the configuration is left on the tag `v1.19.3-final`.
