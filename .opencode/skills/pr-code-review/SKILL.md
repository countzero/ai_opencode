---
name: pr-code-review
description: >
  Multi-pass code review of a pull request, a branch, or the whole repository.
  Use when asked to review code changes, a PR or the whole codebase for defects
  and design issues. Runs 3 review passes with escalating focus, deduplicates
  the findings, keeps Critical/High/Medium with deep links to the code on
  GitHub, and writes the report as Markdown and GitHub-styled HTML to
  `.tmp/reviews/`. Advisory only: never edits code and never writes to GitHub.
---

# Multi-Pass PR Code Review

Three review passes over one diff, each with a different focus: general
defects, cross-file interactions, then absent behavior. A final summary
deduplicates, re-checks, assigns severity and keeps Critical, High and Medium.
Every finding links to its lines on GitHub.

## Scope Resolution

Pick the scope from the request:

| Request                                  | Scope        | Diff                              |
| ---------------------------------------- | ------------ | --------------------------------- |
| "review the PR", "review this branch"    | Branch       | `git diff <base>...HEAD`          |
| "review the whole repo / app / codebase" | Whole        | `git diff <empty-tree> HEAD`      |

**Branch scope:**

1. Run `gh pr view --json number,baseRefName,state,isDraft`.
2. If a PR exists and is closed, tell the user and stop. Otherwise its
   `baseRefName` is the base.
3. If the command fails, no PR exists: the base is `main`, and the user is
   told "No PR found. Diffing against `main`."

**Whole scope:** the base is the empty tree, whose ID comes from
`git hash-object -t tree /dev/null` (on PowerShell:
`$null | git hash-object -t tree --stdin`). Every tracked line then counts as
added, so every rule below that says "added or modified lines" covers the
whole repository. Links use the blob format (*Link Format*), since no PR can
show the whole tree.

In both scopes, also resolve:

- the branch via `git branch --show-current`,
- the full HEAD SHA via `git rev-parse HEAD`,
- owner and repository via `gh repo view --json owner,name`, falling back to
  parsing `git remote get-url origin`,
- the PR number, or `null`.

Uncommitted changes are not part of the review: the links point at HEAD, and a
finding on a line GitHub does not have cannot be opened. Say so when
`git status --short` is not empty.

## Context Gathering

1. **Intent:** the PR title and body when a PR exists
   (`gh pr view --json title,body`), otherwise the commit subjects of the
   range. The repository's `AGENTS.md` and `README.md` state what the code is
   for; read them before the passes.
2. **Full files:** do not read full files upfront. When a hunk lacks the
   context to judge a suspected defect, read the file at that point.

## Design Review

Before the defect passes, judge the change as a whole:

1. **Scope alignment:** does the diff do more or less than the PR, or the
   stated purpose of the repository, describes?
2. **Placement:** does each change live in the file and module that owns that
   concern?
3. **Complexity:** is any part more complex than it needs to be:
   over-engineering, needless abstraction, features nobody asked for?

Design findings go under `### Design`, ahead of the severity tables, and get
no severity; they are observations for the author.

## Workflow and User Communication

Track these steps with the todo tool:

1. Resolve scope, base and context
2. Design review
3. Pass 1
4. Pass 2
5. Pass 3
6. Build the final summary (deduplicate, re-examine, severity, filter), internally only
7. Write the Markdown report to `.tmp/reviews/`
8. Render the HTML report next to it
9. Print the report body in chat, ending with the file-links trailer

After each pass, tell the user in one line how many new defects it found
("Pass 1 complete; found 6 defects.").

Build the summary after Pass 3 without printing it. Write the Markdown file,
render the HTML sibling, and only then print the report body. The chat body
matches the Markdown body byte for byte, minus the YAML front matter, which
lives only in the file. The **last** content of the report message is the
`**Report files:**` trailer; nothing follows it in that message: no recap, no
"Let me know if…".

That rule governs the report **message**, not the session. Where the review is
one step of a larger task (a caller reviewing its own pull request and then
fixing what the review found), the work carries on in the next message, which
opens with its own action rather than a remark about the report. End the turn
only when the review *was* the task. A skill that owns one step must not decide
that the steps after it do not happen.

## Review Passes

All three passes read the full diff. Findings are recorded **without
severity**: File, Line(s), Description.

Flag defects only in added or modified lines, never in unchanged context lines
that happen to appear in a hunk.

Skip a finding that:

- matches one from an earlier pass (same file, overlapping lines);
- describes the same root cause as an existing finding at another location,
  such as a definition and its call site. Keep the one closest to the cause.

**Pass 1: General scan.** Bugs, logic errors, security issues, bad practice,
missing validation, wrong error handling, and the *Project-Specific Review
Checklist* below. Where the repository has tests, check that new or changed
behavior is covered; missing coverage is a finding.

**Pass 2: What was missed.** Assume the first pass missed defects. Focus on
interactions between files, subtle logic errors and implicit assumptions.

**Pass 3: What the code does NOT do.** Assume defects remain. Focus on what is
absent: error handling, edge cases, input validation, null checks, races,
resource leaks, wrong assumptions about state.

Track the findings in conversation context across passes.

## False Positive Exclusion List

Do NOT flag:

- Pre-existing issues outside this diff (in whole scope, nothing is outside).
- Code that looks wrong but is correct.
- Pedantic nitpicks a senior engineer would not raise.
- General code quality concerns the repository's `AGENTS.md` does not require.
- Issues explicitly silenced in code, such as a lint ignore comment.
- Code style or formatting.
- Problems that need a specific input or runtime state nobody would produce.
- A limitation a comment or the README already states as accepted, unless the
  stated reasoning is wrong.

## Project-Specific Review Checklist

Correctness rules no tool checks here. Apply them in every pass.

- **Plugin exports:** OpenCode calls every export of a server plugin module as
  a plugin, so a module under `plugins/` exports plugin functions and nothing
  else. A TUI plugin exports a default `{ id, tui }` and lives outside any
  directory named `plugin` or `plugins`.
- **Startup cost:** a `config` hook blocks startup, and every MCP server waits
  for it. Network or process work there needs a bound (a timeout, an
  `AbortSignal`), and a failure must leave the config usable rather than
  throw.
- **Hook failures:** an exception escaping a hook breaks the step or the start
  it runs in. A hook that can fail catches, logs through `client.app.log`, and
  degrades.
- **Pinned upstream:** the plugins target the OpenCode version the README
  names, and `"autoupdate": false` holds it. Flag use of an experimental hook
  or a renderer internal that the code does not name as such.
- **Config values:** `opencode.json` resolves `{env:…}` and `{file:…}` as text
  before parsing, so a value containing backslashes breaks the JSON. Secrets
  come through `{file:~/.secrets/…}` and never appear literally.
- **Tracked files:** `.gitignore` ignores everything and re-includes an
  allowlist. A new file the change relies on needs its `!` line, or it never
  reaches the repository.
- **Shared resources:** Chrome profiles, slots and processes belong to the
  OpenCode process that claimed them; code must never touch another slot's
  (`.opencode/AGENTS.md` → *Browser Slots*).

## Final Summary

After Pass 3:

1. **Deduplicate:** same file and overlapping lines, or the same root cause at
   different locations. Keep the more detailed description.
2. **Re-examine:** check each remaining finding against the full file, reading
   it now if no pass did. Drop what cannot be confirmed.
3. **Confidence filter:** drop anything below 80% confidence of being a real
   defect. When in doubt, exclude.
4. **Assign severity:**
   - **Critical:** data loss, a security breach, an authentication bypass, a
     crash in normal use, state corruption.
   - **High:** wrong behavior in normal use, an unhandled error path that will
     be hit, a significant logic flaw.
   - **Medium:** bad practice likely to cause bugs, missing validation for an
     unlikely but possible input, a minor logic issue.
5. **Filter:** keep Critical, High and Medium.
6. **Hold for output** until the files are written (*Output Files*). An empty
   set prints the single line `No Critical/High/Medium findings.` in place of
   the severity tables; Design and the trailer still print. Otherwise print one
   table per severity, omitting empty ones, per *Link Format*.

Nothing is written to GitHub; the reader turns findings into PR comments by
hand.

## Output Files

Write both files before printing anything, to `.tmp/reviews/` under the
repository root; create the directory if needed. `.gitignore` must keep it out
of git; check with `git check-ignore -q .tmp/reviews` and stop before writing
if it does not. Write nowhere else.

Every markdown table in the report pads each cell so all cells of a column
share one width (`.opencode/AGENTS.md` → *Output Formatting*).

**Filenames:**

```
pr-review-<branch>-<base>-<head7>.md
pr-review-<branch>-<base>-<head7>.html
```

- `<branch>`: the branch name, lowercased, with `/` replaced by `-`.
- `<base>`: the base branch, or `whole` in whole scope. A different base is a
  different review, so it is always part of the name.
- `<head7>`: the first 7 characters of the HEAD SHA, pinning the report to the
  code reviewed.

A re-run with the same inputs overwrites the earlier report, on purpose.

**Markdown file shape:**

```markdown
---
branch: <branch>
base: <base branch, or whole>
head: <40-character HEAD SHA>
pr: null
generated: <ISO 8601 timestamp with time zone>
files-changed: 12
diff-loc: +1414 / -0
findings:
  critical: <count>
  high: <count>
  medium: <count>
---

# PR Review

## <branch> (vs <base>)

| Field     | Value                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| Branch    | [`<branch>`](https://github.com/OWNER/REPO/tree/<branch>) → [`<base>`](https://github.com/OWNER/REPO/tree/<base>) |
| HEAD      | [`head7`](https://github.com/OWNER/REPO/commit/head7)                                                             |
| PR        | [#42](https://github.com/OWNER/REPO/pull/42) (or `none`)                                                          |
| Generated | YYYY-MM-DD HH:MM                                                                                                  |
| Diff      | 12 files · +1,414 · −0                                                                                            |
| Findings  | 🔴 0 Critical · 🟠 1 High · 🟡 6 Medium                                                                           |

### Design

- ...

### High

| File | Description |
| ---- | ----------- |
| ...  | ...         |
```

In whole scope the H2 reads `## <branch> (whole repository)` and the Branch
row shows only the branch link.

Row rules:

- **Branch:** link each branch to `https://github.com/<owner>/<repo>/tree/<name>`.
  Slashes in the name need no encoding; spaces and other reserved characters
  are percent-encoded.
- **HEAD:** the 7-character SHA as label and in the URL (`/commit/<head7>`),
  which keeps the row narrow enough that the OpenCode TUI does not wrap the
  Field column; GitHub redirects it to the full commit. The full SHA lives in
  the front matter.
- **Diff:** plain text, `<files> files · +<additions> · −<deletions>`, middle
  dots (U+00B7) as separators and the Unicode minus (U+2212) for deletions.
  Emoji or MathJax color here renders as noise or as raw source in the TUI.

`pr` is the PR number or `null`. A `findings` subkey whose severity is empty is
omitted, so the front matter matches the printed tables.

**HTML rendering:** the HTML is the Markdown body rendered by GitHub's
`/markdown` API, wrapped in the skill's templates:

- `templates/report.html`: the page, with `{{TITLE}}`, `{{CSS}}` and
  `{{CONTENT}}` placeholders. The CSS is inlined, so the file stands alone and
  needs no network to view.
- `templates/github-markdown.css`: vendored from the `github-markdown-css`
  package; the version is pinned in its header.

Steps:

1. Read the `.md` file as UTF-8.
2. Strip the front matter with a regex anchored at the start:
   `(?ms)\A---\r?\n.*?\r?\n---\r?\n\r?\n?`. The metadata table stays.
3. `POST /markdown` with `mode=gfm` and capture the HTML fragment.
4. Substitute into `templates/report.html`: `{{TITLE}}` is the H1, `: `, and
   the H2 (`PR Review: <branch> (vs <base>)`), so the browser tab keeps the
   reference; `{{CSS}}` is the stylesheet verbatim; `{{CONTENT}}` is the
   fragment. Do not encode the substitutions.
5. Write the result as UTF-8 without BOM.

Bash (Linux, macOS):

```bash
sed '1{/^---$/!q;};1,/^---$/d' <report.md> \
    | gh api --method POST /markdown --field mode=gfm --field text=@- \
    > <fragment.html>
```

PowerShell decodes a subprocess's stdout through `[Console]::OutputEncoding`,
which on a German Windows host is CP-850. Capturing `gh`'s UTF-8 through it
double-encodes every non-ASCII character (`—` becomes `ÔÇö`, `ü` becomes
`├╝`), and `Set-Content` writes the ANSI code page on PowerShell 5.1:

```PowerShell
$utf8 = [System.Text.UTF8Encoding]::new($false)
$body = [System.IO.File]::ReadAllText($mdPath, $utf8)
$body = $body -replace '(?ms)\A---\r?\n.*?\r?\n---\r?\n\r?\n?', ''
$tmp  = Join-Path (Split-Path $mdPath) 'markdown-body.tmp.txt'
[System.IO.File]::WriteAllText($tmp, $body, $utf8)

$prev = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try {
    $fragment = & gh api --method POST /markdown `
        --field mode=gfm --field "text=@$tmp" | Out-String
} finally {
    [Console]::OutputEncoding = $prev
    Remove-Item $tmp -Force
}

$output = $template.Replace('{{TITLE}}', $title).
    Replace('{{CSS}}', $css).Replace('{{CONTENT}}', $fragment)
[System.IO.File]::WriteAllText($htmlPath, $output, $utf8)
```

**Failure handling:**

| Failure                              | Behavior                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Markdown write fails                 | One line `Failed to write report file: <reason>`, then the full report body in chat. No HTML, no trailer.                 |
| `gh api /markdown` fails             | Keep the `.md`, skip the `.html`, note it in one line before the report body; the trailer lists only the `.md`.           |
| Network unavailable                  | Same as a `gh api` failure.                                                                                               |
| `gh` not authenticated               | Same as a `gh api` failure.                                                                                               |

**Trailer:** the last thing in the report message is `**Report files:**` and a
bullet list of the files actually written, as `file://` links. HTML first, so
the default click opens the rendered view in the browser; Markdown second:

```markdown
**Report files:**

- [Rendered view (HTML, opens in browser)](file:///C:/path/to/repo/.tmp/reviews/pr-review-main-whole-136fd56.html)
- [Markdown source](file:///C:/path/to/repo/.tmp/reviews/pr-review-main-whole-136fd56.md)
```

A `file://` URI uses forward slashes on every platform. On Windows that is
`file:///D:/...` (three slashes, no host). Spaces and other reserved characters
are percent-encoded (`%20`).

## Link Format

**Columns:** File, Description. The File cell is a markdown link whose label is
the path from the repository root with a leading `/`, plus `:{start}-{end}`
(`/plugins/chrome-slot.js:41-43`).

**Line range:** one line of context on each side. A finding on line 42 links to
41-43; one spanning 42-45 links to 41-46. The label always reads
`:{start}-{end}`.

**PR links** (branch scope, PR exists):
`https://github.com/{owner}/{repo}/pull/{pr}/files#diff-{sha256}R{start}-R{end}`,
where `{sha256}` is the hex SHA-256 of the file path:
`node -e "process.stdout.write(require('crypto').createHash('sha256').update('{path}').digest('hex'))"`.

**Blob links** (no PR, or whole scope):
`https://github.com/{owner}/{repo}/blob/{full-sha}/{path}#L{start}-L{end}`.
Blob links use `L` anchors, not `R`.

Correct:

```markdown
| File                                                                                                        | Description                  |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------- |
| [/plugins/chrome-slot.js:41-43](https://github.com/owner/repo/blob/4a7c9e1f/plugins/chrome-slot.js#L41-L43) | Slot claimed on wrong socket |
```

Wrong: a raw URL as the cell, a URL as the label, or a bare filename
(`chrome-slot.js:41-43`) as the label.

## Constraints

- Do NOT modify source code.
- Do NOT post comments, reviews or any data to GitHub.
- Write only the two report files, only under `.tmp/reviews/`.
- Do NOT report style or formatting.
- Do NOT report issues in test files unless they mask a defect in production
  code, nor in generated files, lock files or changelog entries.
- File cells use markdown links with the path as label (*Link Format*).
