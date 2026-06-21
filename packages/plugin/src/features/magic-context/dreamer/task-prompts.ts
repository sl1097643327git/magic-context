import type { DreamingTask } from "../../../config/schema/magic-context";
import type { MaintainMemoryPromptMemory } from "./maintain-memory-gate";

// ── System Prompt ──────────────────────────────────────────────────────────

export const DREAMER_SYSTEM_PROMPT = `You are a memory maintenance agent for the magic-context system.
You run during scheduled dream windows to maintain a project's cross-session memory store and codebase documentation.

## Available Tools

**Memory operations** (ctx_memory with extended dreamer actions):
- \`action="list"\` — browse all active memories, optionally filter by category
- \`action="update", ids=[N], content="..."\` — rewrite a memory's content
- \`action="merge", ids=[N,M,...], content="...", category="..."\` — consolidate duplicates into one canonical memory
- \`action="archive", ids=[N], reason="..."\` — remove a stale memory (soft-archive, with provenance)
- \`action="write", category="...", content="..."\` — create a new memory
- \`action="verified", ids=[N], files=[...]\` — record the COMPLETE current backing-file set after checking a memory; use \`files=[]\` only for file-independent memories
- \`action="classify", ids=[N], importance=75, scope="project", shareable=false\` — dreamer-only metadata write for memory importance, scope, and team-shareability

**Codebase tools** (standard OpenCode tools):
- Read files, grep, glob, bash — for verification against actual code

## Rules

1. **Work methodically.** Decide your own batch size based on the task — process as many items per round as makes sense.
2. **Verify only in verify/docs work.** The verify task checks memories against actual files; curate assumes the pool is accurate and handles quality only; classify uses the provided memory pool + recent trajectory and does not inspect code.
3. **Be conservative with archives.** In verify, archive only when the codebase clearly contradicts the memory; in curate, use the task's archive criteria.
4. **Explain reasoning briefly** before each action — one line is enough.
5. **Use present-tense operational language** in all memory rewrites. "X uses Y" not "X was changed to use Y."
6. **One rule/fact per memory.** Split compound memories during improvement.
7. **Never read or quote secrets** from .env, credentials, keys, or similar sensitive files.
8. **Do not commit changes.** The user handles git operations.

## Memory Taxonomy (5 categories)

Project memory uses exactly 5 categories. Every memory belongs to one:
- **PROJECT_RULES** — durable process/workflow rules for this repo (releases, commits, testing, debugging conventions).
- **ARCHITECTURE** — load-bearing design decisions and WHY they hold (not WHAT a file does).
- **CONSTRAINTS** — hard limits imposed by EXTERNAL systems (APIs, providers, platforms, protocols). Not our own code's behavior.
- **CONFIG_VALUES** — stable configuration keys/values and conventions. Not transient measurements (test counts, sizes, versions).
- **NAMING** — naming conventions and canonical names. Not inventories.

**Legacy categories during transition:** older memories may still carry pre-v2 category names. When you touch one, map it to its 5-category home with \`action="update"\` (or \`merge\`): WORKFLOW_RULES→PROJECT_RULES, ARCHITECTURE_DECISIONS→ARCHITECTURE, CONFIG_DEFAULTS→CONFIG_VALUES, ENVIRONMENT→CONFIG_VALUES (paths) or CONSTRAINTS, KNOWN_ISSUES→CONSTRAINTS only if it's an external-system limit (otherwise archive — our own fixed bugs are not world facts). USER_DIRECTIVES / USER_PREFERENCES are NOT project categories — they live in the global user profile; archive project copies only when they add zero project-specific detail.`;

// ── Verify ─────────────────────────────────────────────────────────────────

function renderMemoryList(memories: MaintainMemoryPromptMemory[]): string {
    return memories
        .map((memory) => {
            const files = memory.mappedFiles.length
                ? memory.mappedFiles.join(", ")
                : "(none mapped yet)";
            return `[${memory.id}] ${memory.category}\nContent: ${memory.content}\nMapped files: ${files}${memory.hasNoFileSentinel ? " (file-independent)" : ""}`;
        })
        .join("\n\n");
}

export function buildVerifyPrompt(args: {
    projectPath: string;
    memories: MaintainMemoryPromptMemory[];
    mode: string;
}): string {
    // adapted from validated shadow-trial prompt; further tuning happens in the harness
    return `## Task: Verify Project Memories Against Code

**Project:** ${args.projectPath}
**Mode:** ${args.mode}

You are given the in-scope memories below (their backing files changed since the last verification, or they were never verified). For EACH one, confirm it against the actual code, fix it if the wording drifted, archive it only if the code clearly contradicts it, and record what you verified it against.

### Process (per memory)
1. Read the mapped files (or grep/read to find the relevant code if none are mapped yet).
2. Decide:
   - Correct as-is → leave content; record \`ctx_memory(action="verified", ids=[N], files=[...COMPLETE backing set...])\`.
   - Wording stale but fact true → \`ctx_memory(action="update", ids=[N], content="...", verified_files=[...COMPLETE backing set...])\`.
   - Code clearly contradicts it → \`ctx_memory(action="archive", ids=[N], reason="...", verified_files=[...])\`. Be conservative: if you can't find the code but it might exist elsewhere, do NOT archive.
   - File-independent (external CONSTRAINT, philosophy) → \`ctx_memory(action="verified", ids=[N], files=[])\`.
3. \`files\` / \`verified_files\` is the COMPLETE current backing set, not just files that changed this run. Include unchanged files that still support the memory.

You do NOT consolidate, improve wording, or archive-for-budget here — that is a separate hygiene task. Only fix accuracy and record the mapping. Every in-scope memory must end recorded (verified, or updated/archived with verified_files).

### In-scope memories
${renderMemoryList(args.memories)}`;
}

// ── Curate ─────────────────────────────────────────────────────────────────

function formatUserProfileList(
    userMemories?: Array<{ id: number; content: string }>,
): string | undefined {
    if (!userMemories || userMemories.length === 0) return undefined;
    return userMemories.map((um) => `- [U${um.id}] ${um.content}`).join("\n");
}

export function buildCuratePrompt(args: {
    projectPath: string;
    memories: MaintainMemoryPromptMemory[];
    userProfile?: string;
}): string {
    // adapted from validated shadow-trial prompt; further tuning happens in the harness
    return `## Task: Curate Project Memory Pool (hygiene)

**Project:** ${args.projectPath}

The memories below are assumed ACCURATE (a separate verify task keeps them true). Your job is pool QUALITY: remove duplicates, tighten wording, and archive low-value entries that waste the ~6000-token injection budget. Explain each action in one line first. Do NOT mint new facts (that is the historian's job).

Work ALL THREE phases below in order (A → B → C) over the whole pool. Do NOT stop after consolidating — a run that only merges and never improves or archives is incomplete.

### Phase A — Consolidate duplicates
Group by category, then merge near-identical / superset-subset / same-fact-different-angle clusters into one canonical memory with \`ctx_memory(action="merge", ids=[...], content="...", category="...")\`. Preserve every unique detail; terse present tense; paths/keys verbatim. Every id in a merge MUST share the same category — the system rejects cross-category merges. If two similar memories sit in different categories they are NOT duplicates (one is miscategorized — archive the redundant one in Phase C instead). One fact per memory.

### Phase B — Improve wording
Rewrite narrative/historical → operational present tense ("X uses Y because Z", not "we switched to Y"); drop session-local context and commit hashes (unless the hash is the point); add specifics where vague. \`write\` is for SPLITS ONLY (update the original down to its first fact, write the second) — a healthy run is net-neutral or net-shrinking, never net-adds facts.

### Phase C — Archive stale / low-value
Archive (with a specific reason) memories that: restate code without rationale · are redundant with a better memory · are stale implementation detail (line numbers/internals) · low signal (seen_count=1, retrieval_count=0, no constraint language) · bare config value · transient measurement · a solved bug in OUR OWN code · redundant with the global user profile (zero added project detail).
KEEP (overrides archive): constraint/rule language (must/never/always) · explains WHY (because/so that/to prevent) · EXTERNAL-system limit (CONSTRAINTS: archive only if word-for-word duplicated) · path/config WITH context · retrieval_count>0 · priority/philosophy.
${args.userProfile ? `\n### Global user profile (for the redundancy check)\n${args.userProfile}\n` : ""}
### Memory pool
${renderMemoryList(args.memories)}`;
}

// ── Classify Memories ──────────────────────────────────────────────────────

export interface ClassifyPromptMemory {
    id: number;
    category: string;
    content: string;
    importance: number;
    scope: "project" | "ecosystem" | "universe";
    shareable: number | boolean;
}

export interface ClassifyTrajectoryCompartment {
    id: number;
    title: string;
    content: string;
    createdAt: number;
}

function renderClassifyMemoryList(memories: ClassifyPromptMemory[]): string {
    return memories
        .map(
            (memory) =>
                `[${memory.id}] ${memory.category} importance=${memory.importance} scope=${memory.scope} shareable=${Boolean(memory.shareable)}\nContent: ${memory.content}`,
        )
        .join("\n\n");
}

function renderTrajectory(compartments: ClassifyTrajectoryCompartment[]): string {
    if (compartments.length === 0) {
        return "(no recent compartments available)";
    }
    return compartments
        .map((compartment) => {
            const created = new Date(compartment.createdAt).toISOString();
            return `[#${compartment.id}] ${created} — ${compartment.title}\n${compartment.content}`;
        })
        .join("\n\n");
}

export function buildClassifyPrompt(args: {
    projectPath: string;
    memories: ClassifyPromptMemory[];
    trajectory: ClassifyTrajectoryCompartment[];
}): string {
    return `## Task: Classify Project Memories

**Project:** ${args.projectPath}

Classify EVERY active/permanent memory below by writing metadata only with \`ctx_memory(action="classify", ... )\`. Do not rewrite, merge, archive, verify, or create memories in this task. Do not inspect the codebase; use the memory content and the recent trajectory below.

### How to score importance (1–100)
Importance decides which memories survive when the injected memory block is over budget: high scores stay in context, low scores drop first. So the score is only useful if it **discriminates** — if most memories land in the same band, you have not classified them, you have just labelled them.

Use LLM judgment, not a formula. Blend:
- **Durability / decay-rate value:** Will this fact still matter weeks from now, across sessions?
- **Current trajectory:** Is it relevant to what the project has recently been doing?
- **Operational impact:** Would missing this fact cause wrong code, wasted time, broken workflows, or violated constraints?

Most memories are ordinary working facts — they belong in the middle, not the top. Reserve the high band for the genuinely load-bearing handful a teammate would be sunk without; push routine observations, one-off details, and now-obvious facts down. A "real, true fact" is not automatically important — truth is not importance.

Rough anchors (not quotas — spread naturally within them): transient/obvious observations 1–30, ordinary helpful project facts 40–65, load-bearing rules/architecture/constraints 70–100. A constraint that is a genuine must/never/always rule the project actively depends on floors around 60; but not every memory in a category is load-bearing — a niche, dated, or narrowly-scoped external quirk (a minor upstream behavior, a harness detail) can sit lower even if it is a "constraint". Score the fact, not the label.

Before you finish: if you find you assigned most of the pool to one band, re-read and differentiate — the spread should reflect that some facts genuinely matter far more than others.

### Scope
- \`project\` — only meaningful inside this repository/product (default when uncertain).
- \`ecosystem\` — useful to sibling projects in the same stack, harness, provider, or company ecosystem.
- \`universe\` — broadly true outside this codebase (protocol/platform/API facts), still written as a concise memory.

### Shareability
Shareability is about EXPOSURE, not scope: **would a teammate working on THIS SAME project benefit from seeing this memory, and is it free of anything personal, local, or sensitive?** If yes, set \`shareable=true\`. This is the COMMON case — most project knowledge is exactly what you'd hand a new teammate: architecture, design rules, conventions, constraints, file locations, hard-won gotchas. Mark those shareable even though they are specific to this repo's internals — that is precisely what helps a teammate here.

Keep \`shareable=false\` only for what is tied to YOU or YOUR machine rather than the project: personal/absolute paths, usernames, local or private endpoints (e.g. localhost), credentials/secrets/tokens, customer data, machine-specific config, and personal working-style preferences. A fact's scope (project/ecosystem/universe) does NOT decide shareability — a project-internal architecture fact is usually shareable; a universally-true personal preference is not. The tool also fails closed and forces secret/credential/personal-path text to private regardless.

Batch ids when they receive the same metadata. Otherwise classify individually. A memory is complete only after you call \`ctx_memory(action="classify", ids=[...], importance=..., scope="...", shareable=...)\` for it.

### Recent trajectory (last ${args.trajectory.length} compartments)
${renderTrajectory(args.trajectory)}

### Memory pool
${renderClassifyMemoryList(args.memories)}`;
}

// ── Retrospective ───────────────────────────────────────────────────────────

export interface RetrospectivePromptEvent {
    sessionId: string;
    kind: string;
    fields: Record<string, string>;
    createdAt: number;
}

export const RETROSPECTIVE_SYSTEM_PROMPT = `You are a retrospective learning agent for Magic Context.

You learn only from recurring user-friction moments where the user had to correct, re-explain, or recover from the assistant's repeated behavior. You receive a pre-rendered friction window from the host and may use ctx_search to look for corroborating prior patterns.

Rules:
1. Pattern, not one-off: extract only recurring behavior that is likely to happen again. Zero learnings is fine.
2. Distill, do not transcribe: never quote the user, never include dates, and never preserve session-local anger.
3. Root cause + correction: the learning must tell a future agent what to do differently.
4. Privacy by host-apply: do not call memory-writing tools. Emit only the XML schema requested by the prompt.`;

/** Tiny system prompt for the cheap LLM gate (turn 1): it reads only U: lines
 *  and answers "n" or "y: <ordinals>". Kept minimal so the gate is cheap. */
export const FRICTION_GATE_SYSTEM_PROMPT =
    "You are a conservative friction detector for a coding agent. You read recent user message lines and decide whether the user was correcting, re-explaining to, or frustrated with the assistant. Output exactly one line and nothing else.";

export function buildFrictionGatePrompt(args: { userLines: string[] }): string {
    return `Decide whether these user lines show the user correcting, re-explaining to, or expressing frustration at the ASSISTANT's behavior — a moment a future assistant should learn from.

Fire (y) when the user: corrects a mistake the assistant made, repeats an instruction the assistant didn't follow, tells the assistant to stop or revert an unwanted action, or shows frustration at repeated assistant behavior.
Do NOT fire (n) for: a normal request or question; the user changing their own mind or fixing their own earlier message ("actually, use X instead — my mistake"); reporting a bug/error/test failure to investigate; a calm one-off "do X instead". The words "no", "not", "error", "fail", "wrong" inside an otherwise-normal sentence are not friction.

Return exactly one line: "n", or "y: <line numbers>". Be conservative.

${args.userLines.join("\n")}`;
}

function renderRetrospectiveEvents(events: RetrospectivePromptEvent[]): string {
    if (events.length === 0) return "(no corroborating historian events)";
    return events
        .map((event) => {
            const fields = Object.entries(event.fields)
                .map(([key, value]) => `${key}: ${value}`)
                .join("; ");
            return `- ${new Date(event.createdAt).toISOString()} session=${event.sessionId} kind=${event.kind}${fields ? ` — ${fields}` : ""}`;
        })
        .join("\n");
}

export function buildRetrospectivePrompt(args: {
    projectPath: string;
    frictionWindow: string;
    events: RetrospectivePromptEvent[];
}): string {
    return `## Task: Retrospective Learning

**Project:** ${args.projectPath}

The host detected possible user friction in the pre-rendered window below. Use it plus ctx_search (if helpful) to decide whether there is a recurring root cause and recurring assistant behavior worth remembering.

### Friction window
${args.frictionWindow}

### Corroborating historian events
${renderRetrospectiveEvents(args.events)}

### Extraction rules
- Extract only durable, recurring learnings. A single annoyed/corrective message is noise.
- Write actionable present-tense corrections for future agents.
- Do NOT quote the user, include dates, or preserve anger/frustration wording.
- Write in plain prose with NO quotation marks at all — not around the user's words, and not around illustrative trigger words. Describe trigger conditions directly (write: when the user asks you to investigate or diagnose without requesting a fix — not: when the user says "investigate"). A learning containing any quotation marks is rejected.
- Use route="memory" for project-specific agent behavior/rules, with category one of PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING.
- Use route="observation" only for recurring user workflow/preferences that belong in the global user profile.
- Zero learnings is acceptable and should be represented by an empty learnings block.

Return only XML in this exact shape:
<learnings>
  <learning route="memory" category="PROJECT_RULES">one durable actionable correction</learning>
  <learning route="observation">one recurring user preference</learning>
</learnings>`;
}

// ── Maintain Docs ──────────────────────────────────────────────────────────

export function buildMaintainDocsPrompt(
    projectPath: string,
    lastDreamAt: string | null,
    existingDocs: { architecture: boolean; structure: boolean },
): string {
    const hasAny = existingDocs.architecture || existingDocs.structure;
    const gitSinceClause = lastDreamAt
        ? `Run \`git log --oneline --since="${new Date(Number(lastDreamAt)).toISOString()}"\` to see what changed since the last dream.`
        : "No previous dream timestamp — treat this as a full analysis.";

    const modeIntro = hasAny
        ? `Some docs already exist. Update only the sections affected by recent changes. Do NOT rewrite unchanged sections.`
        : `No docs exist yet. Create both ARCHITECTURE.md and STRUCTURE.md from scratch using the templates below.`;

    return `## Task: Maintain Codebase Documentation

**Project:** ${projectPath}
**Last dream:** ${lastDreamAt ? new Date(Number(lastDreamAt)).toISOString() : "never"}
**Existing docs:** ARCHITECTURE.md: ${existingDocs.architecture ? "exists" : "missing"}, STRUCTURE.md: ${existingDocs.structure ? "exists" : "missing"}

### Goal
Keep ARCHITECTURE.md and STRUCTURE.md at the project root synchronized with the actual codebase.

${modeIntro}

### Process

1. **Check what changed.** ${gitSinceClause}
2. **Read existing docs** (if they exist) to understand current state.
3. **Explore the codebase** to verify and update:
   - Directory structure: \`find . -type d -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -60\`
   - Entry points: \`ls src/index.* src/main.* 2>/dev/null\`
   - Key imports: \`grep -r "^import\\|^export" src/ --include="*.ts" | head -80\`
4. **Write or update** using the Write tool. Always write to project root, NOT to .planning/.

### Rules
- **NEVER touch protected regions**: any content between \`<!-- mc:protected START ... -->\` and \`<!-- mc:protected END -->\` is hand-authored and cache-critical. Reproduce it BYTE-FOR-BYTE in your rewrite — do not edit, reword, reorder, summarize, trim, or drop a single line of it, and keep the marker comments themselves. Only a human edits that region.
- **Be prescriptive**: "Use X pattern" not "X pattern is used"
- **Always include file paths** in backticks
- **Write current state only**: no temporal language, no history
- **Verify before writing**: read actual files, don't guess
- **Never read .env, credentials, or key files** — note existence only
- **Do not commit** — the user handles git

${!existingDocs.architecture ? ARCHITECTURE_TEMPLATE : ""}
${!existingDocs.structure ? STRUCTURE_TEMPLATE : ""}

### Success criteria
- ARCHITECTURE.md accurately describes current layers, data flows, entry points, and abstractions
- STRUCTURE.md accurately describes directory layout with guidance for where to add new code
- All file paths in docs point to files that actually exist
- Docs are at project root: \`${projectPath}/ARCHITECTURE.md\` and \`${projectPath}/STRUCTURE.md\``;
}

// ── Templates ──────────────────────────────────────────────────────────────

const ARCHITECTURE_TEMPLATE = `
### ARCHITECTURE.md Template (use when creating from scratch)

\`\`\`markdown
# Architecture

## Pattern Overview

**Overall:** [Pattern name — e.g., Plugin-based hook system]

**Key Characteristics:**
- [Characteristic 1]
- [Characteristic 2]

## Layers

**[Layer Name]:**
- Purpose: [What this layer does]
- Location: \\\`[path]\\\`
- Contains: [Types of code]
- Depends on: [What it uses]
- Used by: [What uses it]

## Data Flow

**[Flow Name]:** (e.g., "Transform Pipeline", "Memory Promotion")

1. [Step 1] — \\\`[file]\\\`
2. [Step 2] — \\\`[file]\\\`
3. [Step 3] — \\\`[file]\\\`

## Key Abstractions

**[Abstraction Name]:**
- Purpose: [What it represents]
- Location: \\\`[file paths]\\\`
- Pattern: [Pattern used]

## Entry Points

**[Entry Point]:**
- Location: \\\`[path]\\\`
- Triggers: [What invokes it]
- Responsibilities: [What it does]

## Error Handling

**Strategy:** [Approach — e.g., fail closed, sentinel throws, try/catch with logging]

## Cross-Cutting Concerns

**Logging:** [Approach]
**Caching:** [Approach]
**Storage:** [Approach]
\`\`\``;

const STRUCTURE_TEMPLATE = `
### STRUCTURE.md Template (use when creating from scratch)

\`\`\`markdown
# Codebase Structure

## Directory Layout

\\\`\\\`\\\`
[project-root]/
├── [dir]/          # [Purpose]
├── [dir]/          # [Purpose]
└── [file]          # [Purpose]
\\\`\\\`\\\`

## Directory Purposes

**[Directory Name]:**
- Purpose: [What lives here]
- Contains: [Types of files]
- Key files: \\\`[important files]\\\`

## Key File Locations

**Entry Points:** \\\`[path]\\\`: [Purpose]
**Configuration:** \\\`[path]\\\`: [Purpose]
**Core Logic:** \\\`[path]\\\`: [Purpose]
**Tests:** \\\`[path]\\\`: [Purpose]

## Naming Conventions

**Files:** [Pattern]: [Example]
**Directories:** [Pattern]: [Example]

## Where to Add New Code

**New hook:** \\\`src/hooks/[hook-name]/\\\` — follow existing hook structure
**New tool:** \\\`src/tools/[tool-name]/\\\` — register in tool-registry.ts
**New feature module:** \\\`src/features/[feature-name]/\\\`
**New agent:** \\\`src/agents/[agent-name].ts\\\`
**Shared utilities:** \\\`src/shared/\\\`
**Tests:** co-located with source as \\\`*.test.ts\\\`
\`\`\``;

// ── Dispatcher ─────────────────────────────────────────────────────────────

export function buildDreamTaskPrompt(
    task: DreamingTask,
    args: {
        projectPath: string;
        lastDreamAt?: string | null;
        existingDocs?: { architecture: boolean; structure: boolean };
        userMemories?: Array<{ id: number; content: string }>;
        verify?: {
            memories: MaintainMemoryPromptMemory[];
            mode: "non-git" | "full" | "broad" | "incremental";
        };
        curate?: {
            memories: MaintainMemoryPromptMemory[];
        };
        classify?: {
            memories: ClassifyPromptMemory[];
            trajectory: ClassifyTrajectoryCompartment[];
        };
    },
): string {
    switch (task) {
        case "verify":
        case "verify-broad":
            return buildVerifyPrompt({
                projectPath: args.projectPath,
                memories: args.verify?.memories ?? [],
                // verify-broad always partitions the full pool (mode "broad"); the
                // gate sets the mode, so this just passes it through.
                mode: args.verify?.mode ?? "full",
            });
        case "curate":
            return buildCuratePrompt({
                projectPath: args.projectPath,
                memories: args.curate?.memories ?? [],
                userProfile: formatUserProfileList(args.userMemories),
            });
        case "classify-memories":
            return buildClassifyPrompt({
                projectPath: args.projectPath,
                memories: args.classify?.memories ?? [],
                trajectory: args.classify?.trajectory ?? [],
            });
        case "maintain-docs":
            return buildMaintainDocsPrompt(
                args.projectPath,
                args.lastDreamAt ?? null,
                args.existingDocs ?? { architecture: false, structure: false },
            );
    }
}
