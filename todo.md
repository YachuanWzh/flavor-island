# P1 Backlog (needs flavor-code changes)

Recorded from the P0/P1 triage on 2026-08-26. These require coordinated
changes in the flavor-code repo (external), so they are tracked here for a
later session. All three touch the hook payload contract between
`flavor-code/src/...` and `flavor-island/src/plugin/eventTransform.mjs` +
`flavor-island/src/core/sessionStore.js`.

## P1-1: Command confirmations on the island (/commit, /review, …)

- **Problem:** `flavor-code/src/tools/ask-user-question.ts` `QuestionBridge.ask`
  (used by /commit, /review, /model, …) renders only in the TUI terminal. The
  island's `src/server/hookServer.js` already routes
  `Notification + {question}` to `onQuestion`, but `src/main/main.js` acks it
  silently ("No interactive UI for these yet").
- **Do first:** grep flavor-code for which code paths actually emit
  question-type hook events before building on the protocol.
- **Change (flavor-code):** emit the pending QuestionBridge state as a hook
  event (or a Notification with `question`) so the island can render it.
- **Change (flavor-island):** render an interactive card for `question` kind
  and write the answer back through the existing response path.
- **Verify:** run a `/commit` in flavor-code with the island open; the
  confirm/deny card appears on the island and the answer lands in the TUI.

## P1-2: Task progress on the island (TaskPlan/Todo/Subagent graph)

- **Problem:** flavor-code's TUI has `src/ui/task-progress-model.ts`
  (activeForm, elapsed, ✓/×/·, subagent graph, verification evidence) but hook
  payloads don't carry a task snapshot; the island only shows a generic
  "Planning…".
- **Change (flavor-code):** attach a task snapshot to BeforePlan/AfterPlan (or
  a new Notification payload).
- **Change (flavor-island):** `src/plugin/eventTransform.mjs` flattens the
  snapshot; `src/core/sessionStore.js` + `src/core/renderModel.js` render
  "task 2/5 · implementing cache layer".
- **Verify:** run a plan-driven task in flavor-code; the island expands with a
  live task list.

## P1-3: LoopEnd + loop budget confirmation on the island

- **Problem:** island registers 17 of flavor-code's 20 hook events; `LoopEnd`
  (`/go` mode) is missing, and `src/loop/orchestrator.ts` `confirmBudget`
  (extend loop budget?) is TUI-only.
- **Change (flavor-code):** emit LoopEnd with outcome, and expose
  budget-extension questions through the hook question path.
- **Change (flavor-island):** register LoopEnd in
  `src/plugin/activate.mjs` + `src/plugin/flavor-plugin.json`; render loop
  verification pass/fail and a budget-extension card.
- **Verify:** run `/go` with a failing verifier; the island shows the loop
  terminal state and the budget card.

---

## P2 ideas (not scheduled)

- P2-1 Token/cost stats on the island (needs usage in AfterModelCall payload).
- P2-2 Prepare for flavor-code `pluginSandbox` defaulting to true
  (`production.ts` keeps it opt-in; `activate.mjs` relies on in-process
  `spawn`; `flavor-plugin.json` declares `permissions: []`).
- P2-3 Multi-project interaction: click a row to pin/focus a session.
