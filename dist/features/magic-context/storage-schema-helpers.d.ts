import { Database } from "../../shared/sqlite";
/**
 * Schema-mutation helpers shared by storage-db (fresh-DB init) and migrations
 * (versioned upgrades). They live in this leaf module — depending only on the
 * SQLite handle — so storage-db and migrations don't import each other (storage-db
 * imports `runMigrations` from migrations; without this split, migrations would
 * import these back from storage-db and form an import cycle).
 */
export declare function ensureColumn(db: Database, table: string, column: string, definition: string): void;
/**
 * Heal NULL columns added via ensureColumn against pre-existing rows.
 *
 * SQLite does NOT backfill column defaults when ALTER TABLE ADD COLUMN runs
 * on an already-populated table — old rows get NULL regardless of the
 * DEFAULT clause. isSessionMetaRow used to require strict typeof === "string"
 * / "number", which NULL fails, so rows with NULL columns were rejected,
 * getOrCreateSessionMeta returned zeroed defaults (lastResponseTime=0,
 * cacheTtl="5m"), the scheduler returned "execute" forever, and every
 * execute pass mutated message content — a sustained cache-bust cascade.
 *
 * The validator now tolerates NULL, but we normalize the data too so every
 * code path sees well-formed values. Each UPDATE is best-effort: if a column
 * doesn't exist yet (migration ran on a DB older than the ensureColumn call),
 * the UPDATE throws and we move on — the next schema upgrade runs ensureColumn
 * first, then this heal again.
 *
 * Exported so migration v5 can call it. Not exported from any barrel.
 */
export declare function healAllNullColumns(db: Database): void;
//# sourceMappingURL=storage-schema-helpers.d.ts.map