import type { Database } from "../../shared/sqlite";
export type NoteType = "session" | "smart";
export type NoteStatus = "active" | "pending" | "ready" | "dismissed";
export type NoteCheckStatus = "uncompiled" | "compiled" | "failing" | "fallback";
export interface Note {
    id: number;
    type: NoteType;
    status: NoteStatus;
    content: string;
    sessionId: string | null;
    projectPath: string | null;
    surfaceCondition: string | null;
    createdAt: number;
    updatedAt: number;
    lastCheckedAt: number | null;
    readyAt: number | null;
    readyReason: string | null;
    /** Message ordinal of the live tail when the note was written, so the note
     *  can be traced back to the conversation that produced it. The agent reads
     *  this as the upper bound and expands `anchorOrdinal - x .. anchorOrdinal`
     *  via ctx_expand at its own discretion. Null for notes written before this
     *  was tracked, or when the session had no indexed messages yet. */
    anchorOrdinal: number | null;
    compiledCheck: string | null;
    manifestJson: string | null;
    checkHash: string | null;
    checkCron: string | null;
    checkVersion: number | null;
    checkStatus: NoteCheckStatus | null;
    checkFailureCount: number;
    checkNetworkFailureCount: number;
    checkQuarantinedUntil: number | null;
    checkNextDueAt: number | null;
    checkCompiledAt: number | null;
    checkFalseSinceAt: number | null;
    checkLastLivenessAt: number | null;
    policyVersion: number | null;
}
export interface GetNotesOptions {
    sessionId?: string;
    projectPath?: string;
    type?: NoteType;
    status?: NoteStatus | NoteStatus[];
}
export interface NoteMutationScope {
    sessionId: string;
    projectPath: string;
}
export interface UpdateNoteOptions {
    content?: string;
    sessionId?: string | null;
    projectPath?: string | null;
    surfaceCondition?: string | null;
    status?: NoteStatus;
    lastCheckedAt?: number | null;
    readyAt?: number | null;
    readyReason?: string | null;
}
interface SessionNoteInput {
    sessionId: string;
    content: string;
    anchorOrdinal?: number | null;
}
interface SmartNoteInput {
    content: string;
    sessionId?: string;
    projectPath: string;
    surfaceCondition: string;
    anchorOrdinal?: number | null;
}
export declare function getNotes(db: Database, options?: GetNotesOptions): Note[];
export declare function addNote(db: Database, type: "session", options: SessionNoteInput): Note;
export declare function addNote(db: Database, type: "smart", options: SmartNoteInput): Note;
export declare function getSessionNotes(db: Database, sessionId: string): Note[];
export declare function getSmartNotes(db: Database, projectPath: string, status?: NoteStatus): Note[];
export declare function getPendingSmartNotes(db: Database, projectPath: string): Note[];
export declare function getReadySmartNotes(db: Database, projectPath: string): Note[];
export declare function updateNote(db: Database, noteId: number, updates: UpdateNoteOptions, scope: NoteMutationScope): Note | null;
export declare function dismissNote(db: Database, noteId: number, scope: NoteMutationScope): boolean;
export declare function markNoteReady(db: Database, noteId: number, reason?: string): void;
export declare function markNoteChecked(db: Database, noteId: number): void;
export declare function deleteNote(db: Database, noteId: number): boolean;
export declare function replaceAllSessionNotes(db: Database, sessionId: string, notes: string[]): void;
export {};
//# sourceMappingURL=storage-notes.d.ts.map