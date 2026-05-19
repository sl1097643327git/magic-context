export const CTX_NOTE_DESCRIPTION = `Save or inspect durable session notes that persist for this session.
Use this for short goals, constraints, decisions, or reminders worth carrying forward.

Actions:
- \`write\`: Append one note. Optionally provide \`surface_condition\` to create a smart note.
- \`read\`: Show current notes. Defaults to active session notes + ready smart notes; use \`filter\` to inspect all, pending, ready, active, or dismissed notes.
- \`dismiss\`: Dismiss a note by \`note_id\`.
- \`update\`: Update a note by \`note_id\`.

**Smart Notes**: When \`surface_condition\` is provided with \`write\`, the note becomes a project-scoped smart note. A separate background process (the dreamer) periodically checks the condition using ONLY external, verifiable signals: GitHub state via \`gh\` CLI, web pages, files on disk, git history, etc. The dreamer cannot read your current conversation, cannot detect when the user says something, and has no memory of context that lives only in this session.

Write a smart note ONLY when the surface_condition is something an external agent with read-only tools can definitively check:

✓ GOOD conditions (externally verifiable):
- "When PR #42 in cortexkit/magic-context is merged"
- "When the file packages/plugin/src/foo.ts contains a function named bar"
- "When the latest release tag is >= v0.22.0"
- "When the GitHub Actions workflow runs/123 succeeds"

✗ BAD conditions (require knowing this session's context):
- "When the user mentions the worktree system has landed"  → dreamer cannot see user messages
- "When they ask to re-run the audit fixes"                → dreamer cannot see future requests
- "When we revisit this code path"                         → no observable signal
- "When relevant to the current discussion"                → no observable signal
- "After we finish the current refactor"                   → no externally checkable boundary

If you want context that surfaces based on what's happening in your session, use a regular note (omit surface_condition) — those show up on natural work boundaries within this session. If you want a reminder tied to your future work without a clean external trigger, just write a regular note describing what to do; you'll see it when you read notes later.

Example: \`ctx_note(action="write", content="Implement X because Y", surface_condition="When PR #42 in cortexkit/magic-context is merged")\`

Historian reads these notes, deduplicates them, and rewrites the remaining useful notes over time.`;
