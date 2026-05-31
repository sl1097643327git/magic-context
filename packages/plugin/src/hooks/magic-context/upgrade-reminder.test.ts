import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta-session";
import {
    __resetUpgradeReminderProcessGuard,
    maybeSendUpgradeReminder,
    type UpgradeReminderDeps,
} from "./upgrade-reminder";

let prevDataHome: string | undefined;
let tempHome: string;

beforeEach(() => {
    prevDataHome = process.env.XDG_DATA_HOME;
    tempHome = mkdtempSync(join(tmpdir(), "mc-upgrade-rem-"));
    process.env.XDG_DATA_HOME = tempHome;
    mkdirSync(join(tempHome, "cortexkit", "magic-context"), { recursive: true });
    closeDatabase();
    __resetUpgradeReminderProcessGuard();
});

afterEach(() => {
    closeDatabase();
    if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevDataHome;
    rmSync(tempHome, { recursive: true, force: true });
});

function insertLegacyCompartment(db: ReturnType<typeof openDatabase>, sessionId: string): void {
    db.prepare(
        `INSERT INTO compartments (session_id, sequence, title, content, start_message, end_message, start_message_id, end_message_id, legacy, created_at)
         VALUES (?, 0, 'old', 'flat content', 1, 5, 'm1', 'm5', 1, ?)`,
    ).run(sessionId, Date.now());
}

function insertStagedCompartment(
    db: ReturnType<typeof openDatabase>,
    sessionId: string,
    seq: number,
    endMessage: number,
): void {
    db.prepare(
        `INSERT INTO recomp_compartments (session_id, sequence, start_message, end_message, title, content, pass_number, created_at)
         VALUES (?, ?, 1, ?, 'staged', 'partial', 1, ?)`,
    ).run(sessionId, seq, endMessage, Date.now());
}

/** A fully-upgraded v2 compartment (legacy=0, all tiers populated). */
function insertV2Compartment(db: ReturnType<typeof openDatabase>, sessionId: string): void {
    db.prepare(
        `INSERT INTO compartments (session_id, sequence, title, content, p1, p2, p3, p4, importance, start_message, end_message, start_message_id, end_message_id, legacy, created_at)
         VALUES (?, 0, 'new', 'p1 body', 'p1 body', 'p2', 'p3', 'p4', 50, 1, 5, 'm1', 'm5', 0, ?)`,
    ).run(sessionId, Date.now());
}

function countStaging(db: ReturnType<typeof openDatabase>, sessionId: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS c FROM recomp_compartments WHERE session_id = ?")
        .get(sessionId) as { c: number };
    return row.c;
}

function makeDeps(
    db: ReturnType<typeof openDatabase>,
    sent: string[],
    opts?: {
        tuiConnected?: boolean;
        dialogActions?: string[];
        resumeCaptures?: Array<{ sid: string; resume: unknown }>;
    },
): UpgradeReminderDeps {
    return {
        client: {},
        db,
        sendIgnoredMessage: async (_client, _sid, text) => {
            sent.push(text);
        },
        getNotificationParams: () => ({}),
        // Default to non-TUI so existing assertions exercise the ignored-message path.
        isTuiConnected: () => opts?.tuiConnected ?? false,
        pushTuiDialogAction: (sid, resume) => {
            opts?.dialogActions?.push(sid);
            opts?.resumeCaptures?.push({ sid, resume });
        },
    };
}

describe("E5 upgrade reminder", () => {
    it("fires once for a legacy session and stamps upgradeRemindedAt", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-legacy");
        const sent: string[] = [];

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-legacy");

        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain("/ctx-session-upgrade");
        expect(getOrCreateSessionMeta(db, "ses-legacy").upgradeRemindedAt).not.toBeNull();
    });

    it("enqueues a TUI dialog action (not an ignored message) when a TUI is connected", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-tui");
        const sent: string[] = [];
        const dialogActions: string[] = [];

        await maybeSendUpgradeReminder(
            makeDeps(db, sent, { tuiConnected: true, dialogActions }),
            "ses-tui",
        );

        // TUI path: interactive dialog action enqueued, no transient ignored message.
        expect(dialogActions).toEqual(["ses-tui"]);
        expect(sent).toHaveLength(0);
        // The TUI path does NOT durably stamp on mere display — the stamp is set
        // only on an explicit Confirm/Cancel (via the dismiss-upgrade-reminder
        // RPC). Stamping on display would trap a session the user closed before
        // acting (dogfood 2026-05-30). The per-process guard prevents same-process
        // spam; a new process re-shows until the user decides.
        expect(getOrCreateSessionMeta(db, "ses-tui").upgradeRemindedAt).toBeNull();
    });

    it("re-shows the TUI dialog on a new process when the user never made a choice", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-tui-interrupted");
        const dialogActions: string[] = [];

        await maybeSendUpgradeReminder(
            makeDeps(db, [], { tuiConnected: true, dialogActions }),
            "ses-tui-interrupted",
        );
        // Simulate close-before-acting: new process (in-memory guard cleared).
        __resetUpgradeReminderProcessGuard();
        await maybeSendUpgradeReminder(
            makeDeps(db, [], { tuiConnected: true, dialogActions }),
            "ses-tui-interrupted",
        );

        // No durable stamp was set, so the dialog re-fires on the second process.
        expect(dialogActions).toEqual(["ses-tui-interrupted", "ses-tui-interrupted"]);
    });

    it("does not re-fire after the durable stamp (simulating a new process)", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-legacy");
        const sent: string[] = [];

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-legacy");
        // Reset the in-process guard to simulate a restart — durable stamp must hold.
        __resetUpgradeReminderProcessGuard();
        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-legacy");

        expect(sent).toHaveLength(1);
    });

    it("RE-fires a resume prompt after an interrupted upgrade even with the stamp set", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-resume");
        // Simulate: reminder already fired once (stamp set), upgrade started and
        // staged 3 passes through message 120, then the user closed mid-run.
        updateSessionMeta(db, "ses-resume", { upgradeRemindedAt: Date.now() });
        insertStagedCompartment(db, "ses-resume", 0, 40);
        insertStagedCompartment(db, "ses-resume", 1, 80);
        insertStagedCompartment(db, "ses-resume", 2, 120);
        const sent: string[] = [];

        // New process (in-memory guard cleared by beforeEach).
        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-resume");

        // Despite the durable stamp, the resume prompt fires (non-TUI text path).
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain("interrupted");
        expect(sent[0]).toContain("3 compartments were already rebuilt");
        expect(sent[0]).toContain("message 120");
    });

    it("passes resume info to the TUI dialog action on an interrupted upgrade", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-resume-tui");
        updateSessionMeta(db, "ses-resume-tui", { upgradeRemindedAt: Date.now() });
        insertStagedCompartment(db, "ses-resume-tui", 0, 55);
        const sent: string[] = [];
        const dialogActions: string[] = [];
        const resumeCaptures: Array<{ sid: string; resume: unknown }> = [];

        await maybeSendUpgradeReminder(
            makeDeps(db, sent, { tuiConnected: true, dialogActions, resumeCaptures }),
            "ses-resume-tui",
        );

        expect(dialogActions).toEqual(["ses-resume-tui"]);
        expect(resumeCaptures).toEqual([
            { sid: "ses-resume-tui", resume: { stagedCount: 1, stagedThrough: 55 } },
        ]);
    });

    it("does not re-fire within the same process even before the stamp is read back", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-legacy");
        const sent: string[] = [];

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-legacy");
        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-legacy");

        expect(sent).toHaveLength(1);
    });

    it("skips sessions with no legacy compartments and does NOT stamp", async () => {
        const db = openDatabase();
        // No legacy compartment inserted.
        getOrCreateSessionMeta(db, "ses-clean");
        const sent: string[] = [];

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-clean");

        expect(sent).toHaveLength(0);
        // Not stamped — a future restored pre-v2 session could still need it.
        expect(getOrCreateSessionMeta(db, "ses-clean").upgradeRemindedAt).toBeNull();
    });

    it("transient delivery (Pi toast) does NOT stamp and re-fires on a new process", async () => {
        // Pi delivers via ctx.ui.notify — a transient toast with no scrollback.
        // Stamping on a missed toast permanently suppressed the reminder (dogfood
        // 2026-05-31, Pi session 019de471). With deliveryPersists:false the stamp
        // is never written and the reminder re-fires each process until upgraded.
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-pi");
        const sent: string[] = [];
        const deps = (): UpgradeReminderDeps => ({
            ...makeDeps(db, sent),
            deliveryPersists: false,
        });

        await maybeSendUpgradeReminder(deps(), "ses-pi");
        expect(sent).toHaveLength(1);
        // No durable stamp on a transient toast.
        expect(getOrCreateSessionMeta(db, "ses-pi").upgradeRemindedAt).toBeNull();

        // New process (guard cleared) → re-fires (would have been suppressed by a
        // stamp on the persistent path).
        __resetUpgradeReminderProcessGuard();
        await maybeSendUpgradeReminder(deps(), "ses-pi");
        expect(sent).toHaveLength(2);
    });

    it("transient delivery ignores a STALE durable stamp left by a pre-fix build", async () => {
        // Pi session 019de471 was stamped by the buggy stamp-on-toast path. After
        // the fix, that stale stamp must NOT gate transient delivery.
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-pi-stale");
        updateSessionMeta(db, "ses-pi-stale", { upgradeRemindedAt: Date.now() });
        const sent: string[] = [];

        await maybeSendUpgradeReminder(
            { ...makeDeps(db, sent), deliveryPersists: false },
            "ses-pi-stale",
        );

        // Fires despite the stale stamp (per-process guard governs, not the stamp).
        expect(sent).toHaveLength(1);
    });

    it("skips subagent sessions", async () => {
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-sub");
        updateSessionMeta(db, "ses-sub", { isSubagent: true });
        const sent: string[] = [];

        await maybeSendUpgradeReminder(makeDeps(db, sent), "ses-sub");

        expect(sent).toHaveLength(0);
    });

    it("does NOT show a resume prompt for a fully-upgraded session with orphan staging, and clears it", async () => {
        // Regression (dogfood 2026-05-31, AFT): a session whose compartments are
        // ALL v2 (legacy=0, tiers present) but which still carries leftover
        // recomp_compartments staging from a superseded run must NOT trigger the
        // "Resume the interrupted upgrade?" dialog. The master gate is "has legacy
        // compartments", not "has staging rows".
        const db = openDatabase();
        insertV2Compartment(db, "ses-done"); // fully upgraded
        insertStagedCompartment(db, "ses-done", 0, 40069); // orphan staging
        insertStagedCompartment(db, "ses-done", 1, 40070);
        expect(countStaging(db, "ses-done")).toBe(2);
        const sent: string[] = [];
        const dialogActions: string[] = [];

        await maybeSendUpgradeReminder(
            makeDeps(db, sent, { tuiConnected: true, dialogActions }),
            "ses-done",
        );

        // No prompt of any kind.
        expect(sent).toHaveLength(0);
        expect(dialogActions).toHaveLength(0);
        // Orphan staging garbage-collected so it can't mis-fire on a later restart.
        expect(countStaging(db, "ses-done")).toBe(0);
        // Not stamped.
        expect(getOrCreateSessionMeta(db, "ses-done").upgradeRemindedAt).toBeNull();
    });

    it("STILL resumes a genuinely interrupted upgrade (legacy compartments remain + staging present)", async () => {
        // Guard against over-correction: when legacy compartments DO remain, the
        // resume prompt must still fire even with staging present.
        const db = openDatabase();
        insertLegacyCompartment(db, "ses-mid"); // still has legacy → needs upgrade
        insertStagedCompartment(db, "ses-mid", 0, 200); // partial progress
        const sent: string[] = [];
        const dialogActions: string[] = [];
        const resumeCaptures: Array<{ sid: string; resume: unknown }> = [];

        await maybeSendUpgradeReminder(
            makeDeps(db, sent, { tuiConnected: true, dialogActions, resumeCaptures }),
            "ses-mid",
        );

        expect(dialogActions).toEqual(["ses-mid"]);
        expect(resumeCaptures[0]?.resume).toMatchObject({ stagedCount: 1, stagedThrough: 200 });
        // Staging preserved — the resume needs it.
        expect(countStaging(db, "ses-mid")).toBe(1);
    });
});
