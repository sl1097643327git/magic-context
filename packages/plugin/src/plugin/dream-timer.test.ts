import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../features/magic-context/storage";

/**
 * Regression coverage for the schema-fence / null-DB crash:
 *
 * When the on-disk cache schema is newer than this binary supports (e.g. a
 * stale OpenCode/Pi process still running an older dist after another process
 * migrated the shared DB forward), openDatabase() fails closed by returning a
 * typed-null instead of a live handle. The dream-timer used to drive that null
 * straight into `db.transaction(...)` inside embedding registration, producing
 * a confusing `null is not an object (evaluating 'db.transaction')` TypeError
 * on every 15-minute tick. The timer must instead skip gracefully.
 */
describe("schema-fence null-DB contract", () => {
    test("openDatabase returns falsy (never throws) when DB schema exceeds supported version", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-fence-"));
        const dbPath = join(dir, "context.db");
        try {
            // First open migrates the fresh DB to the current LATEST schema.
            const healthy = openDatabase({ dbPath });
            expect(healthy).toBeTruthy();

            // Re-open pretending this binary only supports schema v0 — any real
            // schema version (>=1) is "newer than supported", so the fence trips.
            // The contract the dream-timer relies on: this returns falsy, it
            // does NOT throw.
            let fenced: unknown;
            expect(() => {
                fenced = openDatabase({ dbPath, latestSupportedVersion: 0 });
            }).not.toThrow();
            expect(fenced).toBeFalsy();

            // A binary that DOES support the schema still opens normally.
            const supported = openDatabase({ dbPath, latestSupportedVersion: 999 });
            expect(supported).toBeTruthy();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/**
 * Static guard: every openDatabase()/openTimerDatabaseOrNull() result in the
 * dream-timer must be null-checked before use, and sweepProject must not carry
 * an `openDatabase()` default param (which would re-introduce an unguarded
 * null). These assertions fail loudly if the guards are ever removed.
 */
describe("dream-timer null-DB guards (static)", () => {
    const source = readFileSync(
        join(import.meta.dir, "dream-timer.ts"),
        "utf8",
    );

    test("defines the guarded open helper and uses it at both entry points", () => {
        expect(source).toContain("function openTimerDatabaseOrNull(");
        expect(source).toContain(
            'openTimerDatabaseOrNull("schedule timer registration")',
        );
        expect(source).toContain('openTimerDatabaseOrNull("maintenance tick")');
    });

    test("guards every guarded-open result with an early return", () => {
        // Count only INVOCATIONS (string-arg call sites), not the function
        // definition. Each must be backed by an `if (!db) return;` guard.
        const callSites = source.match(/openTimerDatabaseOrNull\("/g) ?? [];
        expect(callSites.length).toBeGreaterThanOrEqual(2);
        const guards = source.match(/if \(!db\) return;/g) ?? [];
        expect(guards.length).toBeGreaterThanOrEqual(callSites.length);
    });

    test("sweepProject has no unguarded openDatabase() default param", () => {
        expect(source).not.toContain("db: Database = openDatabase()");
    });
});
