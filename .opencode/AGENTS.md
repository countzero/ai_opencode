# AGENTS.md

Agent instructions for this repository only. A root `AGENTS.md` would sit at
`~/.config/opencode/AGENTS.md` and load into every session in every project, so
this file lives in `.opencode/` and `.opencode/opencode.json` names it under
`instructions`, which OpenCode reads only inside this repository.

## Version Control

Commit only when explicitly asked, push only when explicitly asked, and "commit"
does not imply "push". No `Co-Authored-By` trailer.

## Task Tracking

Work of more than one step states its steps up front and reports each as it
finishes, so a human can follow along.

## Browser Slots

Every OpenCode window drives its own Chrome profile, and `CHROME_SLOT`, set by
the launcher `scripts/opencode.ps1`, names it in the shell. Chrome processes of
another slot belong to another OpenCode window: never kill, close or reuse them.
Kill only processes whose command line carries `opencode-profile-` followed by
the value of `CHROME_SLOT`, and refuse when that variable is unset.

## Output Formatting

Pad every cell of a markdown table so all cells of a column share one width.
The em dash is reserved for interrupted dialogue and a genuine break in
thought; everywhere else use the specific mark. American spelling in code,
comments and English prose.
