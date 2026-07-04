import type { Database } from "../../shared/sqlite";
export interface WorkspaceIdentitySet {
    identities: string[];
    namesByIdentity: Map<string, string>;
}
export interface ExpandedWorkspaceIdentitySet {
    expandedIdentities: string[];
    canonicalIdentityByStoredPath: Map<string, string>;
}
export declare function resolveWorkspaceShareCategories(db: Database, projectIdentity: string): string[] | null;
export declare function resolveWorkspaceIdentitySet(db: Database, projectIdentity: string): WorkspaceIdentitySet;
export declare function expandWorkspaceIdentitySet(db: Database, identities: readonly string[]): string[];
export declare function expandWorkspaceIdentitySetWithAliases(db: Database, identities: readonly string[]): ExpandedWorkspaceIdentitySet;
export declare function resolveStoredPathWorkspaceIdentity(storedProjectPath: string, memberIdentities: readonly string[], canonicalIdentityByStoredPath: ReadonlyMap<string, string>): string | null;
export declare function storedPathBelongsToWorkspace(storedProjectPath: string, memberIdentities: readonly string[], expandedIdentities: readonly string[], canonicalIdentityByStoredPath: ReadonlyMap<string, string>): boolean;
export declare function sourceNameForMemory(storedProjectPath: string, ownIdentity: string, memberIdentities: readonly string[], namesByIdentity: ReadonlyMap<string, string>, canonicalIdentityByStoredPath: ReadonlyMap<string, string>): string | undefined;
export declare function computeWorkspaceEpochFingerprint(db: Database, identities: readonly string[]): string;
export declare function bumpEpochsForWorkspaceMembers(db: Database, identity: string, now?: number): void;
export declare function bumpEpochsForWorkspaceMemberSet(db: Database, identities: readonly string[], now?: number): void;
//# sourceMappingURL=workspaces.d.ts.map