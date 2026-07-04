export type CtxNoteReadFilter = "all" | "active" | "pending" | "ready" | "dismissed";
export interface CtxNoteArgs {
    action?: "write" | "read" | "dismiss" | "update";
    content?: string;
    surface_condition?: string;
    filter?: CtxNoteReadFilter;
    /** Max notes per section for read, newest first (default 25). */
    limit?: number;
    /** Skip this many newest notes for read — pages older ones (default 0). */
    offset?: number;
    note_id?: number;
}
//# sourceMappingURL=types.d.ts.map