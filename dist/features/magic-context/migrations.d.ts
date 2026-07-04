import type { Database } from "../../shared/sqlite";
/**
 * Highest version in the MIGRATIONS array. `LATEST_SUPPORTED_VERSION` in
 * storage-db.ts (the schema-fence ceiling) MUST equal this — a stale ceiling
 * makes the DB refuse to open after the new migration applies (a real bug the
 * project hit during v2 work). A unit test asserts the two stay in lockstep.
 */
export declare const LATEST_MIGRATION_VERSION: number;
/**
 * Detect the specific case where a sibling process already committed the
 * same `schema_migrations` row we're about to insert. Two OpenCode/Pi
 * instances starting concurrently can both read `MAX(version)=N` before
 * either commits. The first commits v(N+1); the second's transaction body
 * runs `migration.up()` (a no-op now that the schema change already
 * landed), then hits PRIMARY KEY conflict on the
 * `INSERT INTO schema_migrations` row.
 *
 * Without this guard the plugin fail-closes and the second instance
 * refuses to start. With it, we recognize "sibling beat us to it",
 * re-read the version, and continue from the next pending migration.
 *
 * Important: only PRIMARY KEY conflicts on `schema_migrations` are
 * swallowed. Any other failure (CREATE TABLE, ALTER TABLE, data heal,
 * etc.) surfaces normally and fail-closes per contract.
 */
export declare function isSiblingMigrationConflict(db: Database, error: unknown, version: number): boolean;
/**
 * Run all pending migrations sequentially.
 * Each migration runs in its own transaction — if it fails, only that migration rolls back.
 * Already-applied migrations are skipped.
 *
 * Multi-instance race tolerance: when two plugin processes start against
 * the same shared DB, both can read the same MAX(version) before either
 * commits. The first wins; the second's INSERT into schema_migrations
 * fails with a PRIMARY KEY conflict. We catch that specific case and
 * resume from the next pending migration. All other migration errors
 * still fail-close per the existing contract.
 */
export declare function runMigrations(db: Database): void;
//# sourceMappingURL=migrations.d.ts.map