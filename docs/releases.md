# Releases

Read when cutting, publishing or verifying a release.

## Order of operations

| Step | What                                                           | Where        |
| ---- | -------------------------------------------------------------- | ------------ |
| 1    | On `main`, commit `Release vX.Y.Z`: the `CHANGELOG.md` section | *Changelog*  |
| 2    | Push it                                                        |              |
| 3    | Publish from that commit                                       | *Publishing* |
| 4    | Verify                                                         | *Verify*     |

## Version

The public API is what someone who reuses this configuration relies on: the
plugins and their options, the launcher and `CHROME_SLOT`, the skills, and the
install steps in `README.md`. The major version is the OpenCode major the
configuration runs on. A change the user has to act on or a new feature raises
the minor version, and a fix alone raises the patch. The version lives only in
the tag and the changelog heading.

## Changelog

`CHANGELOG.md` follows [Common Changelog](https://common-changelog.org). The
choices it leaves open:

- **Written only in the release commit.** No *Unreleased* section: a change's
  commit does not touch it.
- **One line per change** a user notices, from
  `git log --reverse --format='%h %s' v<previous>..main`.
- **References:** the commit as a link. No author names: the project has one
  contributor.
- **Left out:** what reaches no user: `.opencode/AGENTS.md`, `docs/`, the
  Sublime project and repository housekeeping.
- **A notice** when the user has to act before using the version, such as a new
  install step or a renamed secret file.

## Publishing

The tag names the release commit. Pass its SHA to `--target`, not `main`, which
can move before the publish. The release is named `vX.Y.Z`, and its body is two
links:

```markdown
- [Changelog](https://github.com/countzero/ai_opencode/blob/main/CHANGELOG.md#<anchor>)
- [Code Changes](https://github.com/countzero/ai_opencode/compare/v<previous>...vX.Y.Z)
```

The changelog already says what shipped; a second copy is the one nobody
reviews. The anchor is GitHub's slug of the heading: `## [2.0.0] - 2026-10-20`
becomes `#200---2026-10-20`.

```powershell
git fetch origin
git log --max-count=1 --format='%h %s' origin/main   # the release commit
gh release create vX.Y.Z --target (git rev-parse origin/main) --title vX.Y.Z --notes-file <file>
```

The notes file goes under `$env:TEMP`. Publish neither a draft, which creates no
tag, nor a prerelease, which `/releases/latest` skips. Type the body fresh; a
copied one is how one of the compare link's two versions stays stale.

## Verify

| Check                                     | Command                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- |
| The tag is on the release commit          | `git fetch --tags; git log --max-count=1 --format='%h %s' vX.Y.Z` |
| Neither a draft nor a prerelease          | `gh release view vX.Y.Z --json isDraft,isPrerelease`              |
| It is what `/releases/latest` serves      | `gh release view --json tagName`                                  |
| The changelog anchor lands on the heading | Open the release's Changelog link                                 |
