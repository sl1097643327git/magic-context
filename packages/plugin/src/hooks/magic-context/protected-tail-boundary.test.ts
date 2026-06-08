/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import {
    deriveMinForceEligibleTokens,
    deriveProtectedTailTokenTarget,
    MIN_FORCE_ELIGIBLE_TOKENS_CAP,
} from "./protected-tail-boundary";
import { buildTrueRawTokenIndexFromTokenCountsForTest } from "./read-session-true-raw-tokens";

describe("protected-tail size walk", () => {
    it("finds the largest ordinal whose suffix still covers the target tokens", () => {
        const index = buildTrueRawTokenIndexFromTokenCountsForTest("canary", [100, 100, 100]);

        expect(index.findSuffixStartForTokens(150)).toBe(2);
        expect(index.findSuffixStartForTokens(301)).toBe(1);
        expect(index.findSuffixStartForTokens(300)).toBe(1);
        expect(index.findSuffixStartForTokens(0)).toBe(4);
    });
});

describe("protected-tail N clamp", () => {
    it("keeps 8K and 12K windows from collapsing to a 1-token protected tail", () => {
        const eightK = deriveProtectedTailTokenTarget({
            contextLimit: 8_000,
            executeThresholdPercentage: 65,
            usagePercentage: 30,
        });
        const twelveK = deriveProtectedTailTokenTarget({
            contextLimit: 12_000,
            executeThresholdPercentage: 65,
            usagePercentage: 95,
        });

        expect(eightK.ceilingN).toBe(2_080);
        expect(eightK.N).toBe(2_000);
        expect(twelveK.ceilingN).toBe(3_120);
        expect(twelveK.N).toBe(2_000);
        expect(eightK.effectiveFloor).toBeLessThanOrEqual(eightK.ceilingN);
        expect(twelveK.effectiveFloor).toBeLessThanOrEqual(twelveK.ceilingN);
    });

    it("derives the force-head minimum from the scaled tail size", () => {
        expect(MIN_FORCE_ELIGIBLE_TOKENS_CAP).toBe(1_000);
        expect(deriveMinForceEligibleTokens(8)).toBe(1);
        expect(deriveMinForceEligibleTokens(16_000)).toBe(1_000);
    });
});

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    hasRunnableCompartmentWindow,
    resolveOpenCodeProtectedTailBoundary,
    validateBoundarySnapshot,
} from "./protected-tail-boundary";

const boundaryTempDirs: string[] = [];
const originalBoundaryXdg = process.env.XDG_DATA_HOME;

afterEach(() => {
    process.env.XDG_DATA_HOME = originalBoundaryXdg;
    for (const dir of boundaryTempDirs) rmSync(dir, { recursive: true, force: true });
    boundaryTempDirs.length = 0;
});

function useBoundaryTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    boundaryTempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createBoundaryOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; parts: unknown[] }>,
): Database {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    const insertMessage = db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    const insertPart = db.prepare(
        "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    messages.forEach((message, index) => {
        const timestamp = index + 1;
        insertMessage.run(
            message.id,
            sessionId,
            timestamp,
            timestamp,
            JSON.stringify({ id: message.id, role: message.role, sessionID: sessionId }),
        );
        message.parts.forEach((part) => {
            insertPart.run(message.id, sessionId, timestamp, timestamp, JSON.stringify(part));
        });
    });
    return db;
}

function createContextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

describe("protected-tail boundary integration", () => {
    it("exposes a runnable head for a sparse #132-shaped session under pressure", () => {
        useBoundaryTempDataHome("protected-tail-132-");
        const sessionId = "ses-132";
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
            {
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "start the long autonomous task" }],
            },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "working" }] },
            { id: "m3", role: "user", parts: [{ type: "text", text: "continue" }] },
            ...Array.from({ length: 20 }, (_, index) => ({
                id: `m${index + 4}`,
                role: "assistant",
                parts: [{ type: "text", text: `autonomous output ${index} `.repeat(1000) }],
            })),
        ]);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 12_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 95, inputTokens: 7_400 },
                usageSource: "live",
            });

            expect(snapshot.protectedTailStart).toBeGreaterThan(1);
            expect(hasRunnableCompartmentWindow(snapshot)).toBe(true);
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });

    it("bails out when a boundary snapshot's eligible raw range changes", () => {
        useBoundaryTempDataHome("protected-tail-stale-");
        const sessionId = "ses-stale-boundary";
        const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
            { id: "m1", role: "user", parts: [{ type: "text", text: "eligible" }] },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "also eligible" }] },
            { id: "m3", role: "user", parts: [{ type: "text", text: "protected".repeat(2000) }] },
        ]);
        const db = createContextDb();
        try {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 8_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 95, inputTokens: 5_000 },
                usageSource: "live",
            });
            opencodeDb
                .prepare(
                    "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
                )
                .run("m1", sessionId, 1, 1, JSON.stringify({ type: "text", text: "late edit" }));

            expect(validateBoundarySnapshot({ db, snapshot })).toEqual(
                expect.objectContaining({ ok: false, reason: "stale_snapshot" }),
            );
        } finally {
            closeQuietly(db);
            closeQuietly(opencodeDb);
        }
    });
});

it("manual full recomp protects an in-progress open tool arc", () => {
    useBoundaryTempDataHome("protected-tail-manual-open-arc-");
    const sessionId = "ses-manual-open-arc";
    const opencodeDb = createBoundaryOpenCodeDb(sessionId, [
        { id: "m1", role: "user", parts: [{ type: "text", text: "eligible" }] },
        {
            id: "m2",
            role: "assistant",
            parts: [{ type: "tool", callID: "call-open", state: { input: { command: "long" } } }],
        },
        { id: "m3", role: "assistant", parts: [{ type: "text", text: "still running" }] },
    ]);
    const db = createContextDb();
    try {
        const snapshot = resolveOpenCodeProtectedTailBoundary({
            db,
            sessionId,
            mode: "manual-full-recomp",
            contextLimit: 128_000,
            executeThresholdPercentage: 65,
            usage: null,
            usageSource: "manual-none",
        });

        expect(snapshot.protectedTailStart).toBe(2);
        expect(snapshot.eligibleEndOrdinal).toBe(2);
    } finally {
        closeQuietly(db);
        closeQuietly(opencodeDb);
    }
});
