# Migrate a Machine from OpenCode 1.x to 2.0

For a Windows machine that runs this configuration on OpenCode 1.x (`opencode-ai`, `opencode-claude-auth@2.2.1`). Tested with `@opencode/cli` 2.0.32 and `opencode-claude-auth@3.0.0`.

There is no in-between state: 1.x and 2.0 install the same `opencode` command, and no version of the Claude login plugin serves both. Run the steps in one go.

## 1. Back up

Close every OpenCode window. The first 2.0 start migrates the 1.x database in place, so copy it first:

```PowerShell
Copy-Item -Recurse "$HOME\.local\share\opencode" "$HOME\.local\share\opencode-1.x-backup"
```

## 2. Switch the configuration

```PowerShell
git -C "$HOME\.config\opencode" fetch
git -C "$HOME\.config\opencode" checkout opencode-2
```

## 3. Replace OpenCode

From `cmd` or Win+R, not from a PowerShell with a conda environment active, where `npm` installs into conda instead:

```
cmd /c npm -g uninstall opencode-ai opencode-claude-auth & rd /s /q "%USERPROFILE%\.cache\opencode" 2>nul & npm -g install @opencode/cli@2 && opencode service set disabled true && opencode plugin add opencode-claude-auth@3.0.0 || pause
```

- The uninstall comes first: both packages install the `opencode` command, so installing over the other fails.
- The cache holds the 1.x plugin installs; 2.0 does not use them.
- `service set disabled true` gives every window a private server that inherits its environment, so each window gets its own Chrome slot. It costs `/pair` and attaching a second client to a running session.
- `plugin add` installs the Claude login plugin in the foreground. Left to startup, the first install takes about a minute on Windows, past the 5 s OpenCode gives plugins to activate, so every start fails with "Location plugins did not finish activating" and abandons the install. The plugin is already in `opencode.json`, so the command reports it as configured and only installs it.

## 4. Update the PowerShell profile

In `$PROFILE.CurrentUserAllHosts`, delete these lines; 2.0 no longer reads them, and their features are the defaults:

```PowerShell
$env:OPENCODE_EXPERIMENTAL_CODE_MODE = 'true'
$env:OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = '128000'
$env:OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = 'true'
```

Add the launcher, which claims the Chrome slot:

```PowerShell
function opencode { & "$HOME\.config\opencode\scripts\opencode.ps1" @args }
```

Open a new terminal so both changes apply.

## 5. Log in

1. Start `opencode`. Sessions from 1.x appear once a background job has copied them; a large database takes a while.
2. `/connect`, then **Anthropic**, then **Import Claude Code subscription**. It reads `~/.claude/.credentials.json`, so Claude Code must be logged in. `opencode auth list` confirms it.
3. `opencode mcp auth atlassian` in a shell; 2.0 does not take over the 1.x MCP logins.

## 6. Verify

| Check                                     | Expected                                                       |
| ----------------------------------------- | -------------------------------------------------------------- |
| `opencode --version`                      | `2.0.x`                                                        |
| `opencode service status`                 | `stopped`                                                      |
| `opencode debug config`                   | No warnings about `opencode.json`                              |
| `opencode mcp list`                       | `chrome-devtools`, `chrome-android`, `blender` connect         |
| Terminal title                            | `[N] OpenCode`; a second window shows another `N`              |
| `$env:CHROME_SLOT` in a shell             | The same `N`                                                   |
| `/models`                                 | Claude models, and the presets of every reachable llama-server |
| `npm audit signatures` in `%APPDATA%\npm` | All packages verified                                          |

## 7. Projects

2.0 changes three things outside this repository:

- **`CLAUDE.md`** no longer loads. In a project whose only rules file it is, rename it to `AGENTS.md`; Claude Code reads that too.
- **1.x plugins** in a project's `.opencode/plugins/` fail to load. A plugin that only sets `SESSION_ID` in shells can go: 2.0 sets `OPENCODE_SESSION_ID` itself. Others need a port to the `{ id, setup(ctx) }` API.
- **`edit` rules** with relative paths outside the project (`"../*": "deny"`) never match: 2.0 matches paths outside the project as absolute paths, such as `"D:/Arbeit/**": "deny"`.

## Update later

```
cmd /c opencode service stop 2>nul & npm -g install @opencode/cli@2 || pause
```

After raising the plugin's version in `opencode.json`, run `opencode plugin add opencode-claude-auth@<version>` before the next start, for the reason in step 3.

## Roll back

Close OpenCode, then:

```
cmd /c npm -g uninstall @opencode/cli & npm -g install opencode-ai@1 || pause
```

```PowerShell
git -C "$HOME\.config\opencode" checkout main
Remove-Item -Recurse "$HOME\.local\share\opencode"
Rename-Item "$HOME\.local\share\opencode-1.x-backup" opencode
```

Restore the profile lines from step 4. Restoring the backup rather than reusing the migrated database is deliberate: 1.x would not see sessions made in 2.0.
