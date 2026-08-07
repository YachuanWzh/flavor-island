<!-- SUPERHARNESS:FLAVOR-BEGIN -->
## Superharness

This project has **superharness** installed as a flavor-code plugin under
`.flavor/plugins/superharness/`. It registers a skill root that provides
engineering-discipline skills for autonomous development, plus SessionStart /
UserPromptSubmit / Stop hooks that inject `HARNESS.md` into every session and
track `/go` tasks under `.flavor/superharness/ralph/`.

Installed skills: `brainstorm`, `go`, `light`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `verification-before-completion`, `writing-plans`

Key capabilities:
- **go** -- Drive a task end-to-end under strict TDD + verification + code review discipline.
- **light** -- Lightweight mode for small focused tasks: TDD with exemptions, real-output verification, no worktree/plan-file/ralph overhead.
- **brainstorm** -- Explore requirements with a live browser mind map (manual trigger only).
- **test-driven-development** -- RED-GREEN-REFACTOR cycle. No production code without a failing test first.
- **systematic-debugging** -- Root-cause tracing, defense-in-depth, no guess-and-patch.
- **verification-before-completion** -- Run the full test suite and show real output before claiming done.
- **requesting-code-review** -- Dispatch a reviewer subagent over the diff.
- **writing-plans** -- Break down multi-step work into bite-sized TDD tasks.
- **using-git-worktrees** -- Isolate work in a disposable workspace.
- **subagent-driven-development** -- Execute multi-task plans with parallel subagents.

Usage in flavor-code: `/<skill-name> <args>`, e.g. `/go refactor login module` or `/brainstorm payment plan`.
<!-- SUPERHARNESS:FLAVOR-END -->