---
name: plan-review
description: Second-pass review of a plan before presenting it to the user. Use when about to present a non-trivial plan in plan mode, or a multi-step implementation outline in build mode (a todo list with 3+ non-trivial items, or a response describing edits to 2+ files). Skip for trivial or one-line changes, or when the user asked for "minimal", "quick", "just do X" or the "smallest fix". Applies ten design lenses and emits a one-line tail marker only when the pass changes the plan.
---

# Plan Review (Second Pass)

## When to fire

Fire when ALL of the following hold:

- The plan writes or changes code, configuration, or a structured authored artifact (a ticket, a design document, a wiki page).
- The plan touches more than one file, introduces a new abstraction (function, class, type, module, config key, route, schema field, table, environment variable), or rewrites several sections of one artifact.
- The user has not asked for a minimal, quick or smallest answer.

Fires in plan mode AND in build mode: a multi-file edit outline, or a todo list with 3+ non-trivial items, counts as a plan.

Skip for pure questions, file inspection, one-line fixes and mechanical edits.

## Workflow

1. Draft the first-pass plan internally.
2. Walk each lens below as a single probe. Revise the plan if a probe yields a concrete removal or simplification.
3. Present the (possibly revised) plan. Append the tail marker ONLY if the second pass changed something.

## Lenses

| Lens                            | Probe                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| YAGNI                           | Anything in this plan the current request does not require?                               |
| KISS                            | What is the simplest version that still solves the problem? Why isn't that the plan?      |
| DRY                             | Is this knowledge already represented somewhere reusable in the codebase?                 |
| SOLID                           | Does any single piece have more than one reason to change? Split it.                      |
| Premature Optimization          | Is complexity added for an unmeasured performance concern?                                |
| Occam's Razor                   | Is there a simpler explanation of the problem that would make a smaller plan sufficient? |
| Tesler's Conservation           | Is the irreducible complexity placed in the layer or module that owns it?                 |
| Gall's Law                      | Does it grow a working simple system, or design the complexity up front?                  |
| Principle of Least Astonishment | Will the next reader be surprised by naming, dependency direction or layering?            |
| Inversion                       | What would make this plan obviously bad? Is it close to any such failure mode?            |

## Disclosure

If, and only if, the second pass changed something, append exactly one tail line to the plan, after a blank line:

```
[reviewed: <lens-1>[, <lens-2>...]] <what changed, 6-12 words>
```

Examples:

- `[reviewed: YAGNI] dropped the cache layer, it has only one caller`
- `[reviewed: KISS, DRY] collapsed two helpers into the existing util`
- `[reviewed: SOLID] split the orchestrator from the persistence path`

If the pass changed nothing, emit no marker. Silence is honest.

## Don't

- Don't recite the lens list in the plan body.
- Don't claim adherence ("adheres to KISS"). Either name a lens that drove a concrete change, or stay silent.
- Don't fire on trivial tasks. Most sessions don't need this.
