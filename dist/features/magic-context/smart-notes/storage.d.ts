import type { Database } from "../../../shared/sqlite";
import { type NoteCheckStatus } from "../storage-notes";
import { type SmartNoteCheckManifest, type SmartNoteCheckNote } from "./types";
export declare function commitSmartNoteState(db: Database, args: {
    phase: string;
    leaseHeld?: () => boolean;
    write: () => void;
}): void;
export declare function getDueCompiledSmartNoteChecks(db: Database, projectPath: string, now: number, limit: number): SmartNoteCheckNote[];
export declare function getSmartNotesNeedingCompilation(db: Database, projectPath: string, now: number, limit: number): SmartNoteCheckNote[];
export declare function getStaleCompiledSmartNotes(db: Database, projectPath: string, now: number, limit: number): SmartNoteCheckNote[];
export declare function storeCompiledSmartNoteCheck(db: Database, args: {
    noteId: number;
    compiledCheck: string;
    manifest: SmartNoteCheckManifest;
    checkHash: string;
    checkCron: string;
    nextDueAt: number;
    now: number;
}): void;
export declare function markCompiledCheckFalse(db: Database, noteId: number, nextDueAt: number, now: number): void;
export declare function markCompiledCheckLogicFailure(db: Database, noteId: number, now: number, maxFailures: number): void;
export declare function markCompiledCheckNetworkFailure(db: Database, noteId: number, now: number, maxFailures: number): void;
export declare function markSmartNoteLivenessChecked(db: Database, noteId: number, now: number): void;
export declare function markSmartNoteCheckStatus(db: Database, noteId: number, status: NoteCheckStatus, now: number): void;
export declare function markSmartNoteCompilationFailure(db: Database, noteId: number, now: number, maxFailures: number): void;
//# sourceMappingURL=storage.d.ts.map