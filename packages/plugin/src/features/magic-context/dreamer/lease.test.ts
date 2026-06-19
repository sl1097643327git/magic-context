/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    acquireLease,
    DREAMING_LEASE_KEY,
    getLeaseHolder,
    isLeaseActive,
    releaseLease,
    renewLease,
} from "./lease";

function makeDb(path = ":memory:"): Database {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("dreamer lease (atomic CAS)", () => {
    it("acquires, renews for the same holder, and releases", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        expect(isLeaseActive(db)).toBe(true);
        expect(getLeaseHolder(db)).toBe("holder-a");
        expect(renewLease(db, "holder-a")).toBe(true);
        releaseLease(db, "holder-a");
        expect(isLeaseActive(db)).toBe(false);
        expect(getLeaseHolder(db)).toBeNull();
        closeQuietly(db);
    });

    it("blocks a second holder while the lease is active", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        expect(acquireLease(db, "holder-b")).toBe(false);
        expect(getLeaseHolder(db)).toBe("holder-a");
        closeQuietly(db);
    });

    it("keyed leases for different domains do NOT block each other", () => {
        const db = makeDb();
        // memory domain held — key-files and global user-memories stay free.
        expect(acquireLease(db, "h-mem", "memory:git:abc")).toBe(true);
        expect(acquireLease(db, "h-kf", "key-files:git:abc")).toBe(true);
        expect(acquireLease(db, "h-um", "user-memories")).toBe(true);
        // Same memory domain, second holder → blocked.
        expect(acquireLease(db, "h-mem2", "memory:git:abc")).toBe(false);
        // Same domain but DIFFERENT project → independent, free.
        expect(acquireLease(db, "h-mem3", "memory:git:other")).toBe(true);
        expect(getLeaseHolder(db, "memory:git:abc")).toBe("h-mem");
        expect(getLeaseHolder(db, "key-files:git:abc")).toBe("h-kf");
        expect(isLeaseActive(db, "user-memories")).toBe(true);
        closeQuietly(db);
    });

    it("releasing one keyed lease leaves siblings untouched", () => {
        const db = makeDb();
        expect(acquireLease(db, "h-mem", "memory:git:abc")).toBe(true);
        expect(acquireLease(db, "h-kf", "key-files:git:abc")).toBe(true);
        releaseLease(db, "h-mem", "memory:git:abc");
        expect(isLeaseActive(db, "memory:git:abc")).toBe(false);
        expect(isLeaseActive(db, "key-files:git:abc")).toBe(true);
        expect(getLeaseHolder(db, "key-files:git:abc")).toBe("h-kf");
        closeQuietly(db);
    });

    it("legacy default key is isolated from new keyed leases", () => {
        const db = makeDb();
        expect(acquireLease(db, "legacy-holder")).toBe(true); // default = DREAMING_LEASE_KEY
        expect(isLeaseActive(db, DREAMING_LEASE_KEY)).toBe(true);
        // A keyed domain lease is unaffected by the legacy lease being held.
        expect(acquireLease(db, "h-mem", "memory:git:abc")).toBe(true);
        expect(isLeaseActive(db)).toBe(true); // legacy still held
        closeQuietly(db);
    });

    it("lets another holder reclaim an expired lease", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        // Force expiry in the past.
        db.prepare("UPDATE dream_state SET value = ? WHERE key = 'dreaming_lease_expiry'").run(
            String(Date.now() - 1),
        );
        expect(acquireLease(db, "holder-b")).toBe(true);
        expect(getLeaseHolder(db)).toBe("holder-b");
        closeQuietly(db);
    });

    it("renew fails for holder mismatch or expired lease", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        expect(renewLease(db, "holder-b")).toBe(false);
        db.prepare("UPDATE dream_state SET value = ? WHERE key = 'dreaming_lease_expiry'").run(
            String(Date.now() - 1),
        );
        expect(renewLease(db, "holder-a")).toBe(false);
        closeQuietly(db);
    });

    it("release is a no-op after another holder reclaims the lease", () => {
        const db = makeDb();
        expect(acquireLease(db, "holder-a")).toBe(true);
        db.prepare("UPDATE dream_state SET value = ? WHERE key = 'dreaming_lease_expiry'").run(
            String(Date.now() - 1),
        );
        expect(acquireLease(db, "holder-b")).toBe(true);
        // holder-a's stale release must NOT clear holder-b's live lease.
        releaseLease(db, "holder-a");
        expect(getLeaseHolder(db)).toBe("holder-b");
        expect(isLeaseActive(db)).toBe(true);
        closeQuietly(db);
    });

    it("allows exactly one winner across separate DB handles", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-dream-lease-handles-"));
        const path = join(dir, "context.db");
        const dbA = makeDb(path);
        const dbB = makeDb(path);
        try {
            const results = [acquireLease(dbA, "holder-a"), acquireLease(dbB, "holder-b")];
            // Exactly one process may hold the global dream lease at a time.
            expect(results.filter(Boolean)).toHaveLength(1);
        } finally {
            closeQuietly(dbA);
            closeQuietly(dbB);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("allows exactly one winner across subprocesses sharing a DB", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-dream-lease-process-"));
        const path = join(dir, "context.db");
        const setup = makeDb(path);
        closeQuietly(setup);
        try {
            const pluginRoot = process.cwd().endsWith("/packages/plugin")
                ? process.cwd()
                : join(process.cwd(), "packages", "plugin");
            const script = `
                const sqlite = await import(${JSON.stringify(`file://${pluginRoot}/src/shared/sqlite.ts`)});
                const storageDb = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/storage-db.ts`)});
                const migrations = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/migrations.ts`)});
                const lease = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/dreamer/lease.ts`)});
                const db = new sqlite.Database(${JSON.stringify(path)});
                storageDb.initializeDatabase(db);
                migrations.runMigrations(db);
                const ok = lease.acquireLease(db, process.argv.at(-1) ?? "missing-holder");
                db.close();
                console.log(JSON.stringify({ ok }));
            `;
            const [a, b] = await Promise.all([
                $`bun -e ${script} holder-a`.json() as Promise<{ ok: boolean }>,
                $`bun -e ${script} holder-b`.json() as Promise<{ ok: boolean }>,
            ]);
            expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
