import { afterEach, describe, expect, it, mock } from "bun:test";
import {
    closeDatabase,
    getChannel2NudgeClaimedAt,
    getChannel2NudgeState,
    openDatabase,
    setChannel2NudgeState,
} from "../../features/magic-context/storage";
import { setLiveServerWakeAvailable } from "../../shared/live-server-client";
import { maybeDeliverChannel2 } from "./channel2-delivery";

function useTempDataHome(prefix: string): void {
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), prefix));
}

const SERVER = "http://127.0.0.1:5599";

afterEach(() => {
    closeDatabase();
});

describe("maybeDeliverChannel2", () => {
    it("no-ops when no pending intent exists", async () => {
        useTempDataHome("ch2-noop-");
        const db = openDatabase()!;
        setLiveServerWakeAvailable(SERVER, true);
        const delivered = await maybeDeliverChannel2("ses-noop", {
            db,
            serverUrl: SERVER,
            directory: ".",
        });
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-noop")).toBe("");
    });

    it("no-ops (keeps pending) when the live server is unreachable (plain TUI)", async () => {
        useTempDataHome("ch2-unreachable-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-tui", "pending");
        // Mark this server as probed-and-unreachable (the plain-TUI 404 case).
        setLiveServerWakeAvailable(SERVER, false);
        const delivered = await maybeDeliverChannel2("ses-tui", {
            db,
            serverUrl: SERVER,
            directory: ".",
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });
        expect(delivered).toBe(false);
        // Intent stays pending — Channel 2 is simply disabled here, not consumed.
        expect(getChannel2NudgeState(db, "ses-tui")).toBe("pending");
    });

    it("does NOT deliver and leaves pending when the baseline is unknown", async () => {
        useTempDataHome("ch2-unknown-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-unknown", "pending");
        setLiveServerWakeAvailable(SERVER, true);
        const delivered = await maybeDeliverChannel2("ses-unknown", {
            db,
            serverUrl: SERVER,
            directory: ".",
            // No reclaimable/usable measurement at this event.
        });
        // Unknown pressure must never burn the one-shot cap NOR cancel the
        // intent — a later final-stop with a real measurement decides.
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-unknown")).toBe("pending");
    });

    it("cancels (re-armable) when the full trigger predicate no longer holds", async () => {
        useTempDataHome("ch2-stale-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-stale", "pending");
        setLiveServerWakeAvailable(SERVER, true);
        // 11k reclaimable >= 10k floor but < usable/3 (44k/3 ≈ 14.7k): the
        // audit repro — floor-only validation delivered this stale nudge and
        // permanently burned the one-per-session cap.
        const delivered = await maybeDeliverChannel2("ses-stale", {
            db,
            serverUrl: SERVER,
            directory: ".",
            reclaimableTokens: 11_000,
            usableTokens: 44_000,
        });
        expect(delivered).toBe(false);
        // Cancelled to '' (re-armable), NOT 'delivered' — cap preserved.
        expect(getChannel2NudgeState(db, "ses-stale")).toBe("");
    });

    it("boot-heals only stale claimed leases, not fresh live claims", () => {
        useTempDataHome("ch2-ttl-heal-");
        let db = openDatabase()!;
        setChannel2NudgeState(db, "ses-fresh-claim", "claimed");
        setChannel2NudgeState(db, "ses-stale-claim", "claimed");
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_claimed_at = ? WHERE session_id = ?",
        ).run(Date.now() - 180_000, "ses-stale-claim");

        closeDatabase();
        db = openDatabase()!;

        expect(getChannel2NudgeState(db, "ses-fresh-claim")).toBe("claimed");
        expect(getChannel2NudgeClaimedAt(db, "ses-fresh-claim")).toBeGreaterThan(0);
        expect(getChannel2NudgeState(db, "ses-stale-claim")).toBe("pending");
        expect(getChannel2NudgeClaimedAt(db, "ses-stale-claim")).toBe(0);
    });

    it("delivers via the live-server client and consumes the one-shot cap", async () => {
        useTempDataHome("ch2-deliver-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-go", "pending");
        setLiveServerWakeAvailable(SERVER, true);

        const promptAsync = mock(async () => ({}));
        const messages = mock(async () => ({ data: [] }));
        mock.module("../../shared/live-server-client", () => ({
            getLiveServerClient: () => ({ session: { promptAsync, messages } }),
            hasFreshProbe: () => true,
            probeServerReachable: async () => true,
            useLiveServerWake: () => true,
            setLiveServerWakeAvailable: () => {},
        }));

        const { maybeDeliverChannel2: deliver } = await import("./channel2-delivery");
        const delivered = await deliver("ses-go", {
            db,
            serverUrl: SERVER,
            directory: ".",
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });

        expect(delivered).toBe(true);
        expect(promptAsync).toHaveBeenCalledTimes(1);
        const callArg = promptAsync.mock.calls[0]![0] as {
            path: { id: string };
            body: { noReply: boolean; parts: Array<{ text: string }> };
        };
        expect(callArg.path.id).toBe("ses-go");
        expect(callArg.body.noReply).toBe(false);
        expect(callArg.body.parts[0]!.text).toContain("<system-reminder>");
        expect(callArg.body.parts[0]!.text).toContain("ctx_reduce");
        // One-shot cap consumed.
        expect(getChannel2NudgeState(db, "ses-go")).toBe("delivered");
    });

    it("treats a lost post-send confirm CAS as unconfirmed without reverting to pending", async () => {
        useTempDataHome("ch2-confirm-lost-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-confirm-lost", "pending");
        setLiveServerWakeAvailable(SERVER, true);

        const promptAsync = mock(async () => {
            // Simulate a sibling process consuming/cancelling the claim after the
            // send returns but before this process can confirm claimed→delivered.
            setChannel2NudgeState(db, "ses-confirm-lost", "");
        });
        mock.module("../../shared/live-server-client", () => ({
            getLiveServerClient: () => ({ session: { promptAsync, messages: async () => [] } }),
            hasFreshProbe: () => true,
            probeServerReachable: async () => true,
            useLiveServerWake: () => true,
            setLiveServerWakeAvailable: () => {},
        }));

        const { maybeDeliverChannel2: deliver } = await import("./channel2-delivery");
        const delivered = await deliver("ses-confirm-lost", {
            db,
            serverUrl: SERVER,
            directory: ".",
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });

        expect(promptAsync).toHaveBeenCalledTimes(1);
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-confirm-lost")).toBe("delivered");
    });

    it("reverts claimed→pending on send failure (cap not burned)", async () => {
        useTempDataHome("ch2-fail-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-fail", "pending");
        setLiveServerWakeAvailable(SERVER, true);

        const promptAsync = mock(async () => {
            throw new Error("transient network failure");
        });
        mock.module("../../shared/live-server-client", () => ({
            getLiveServerClient: () => ({ session: { promptAsync, messages: async () => [] } }),
            hasFreshProbe: () => true,
            probeServerReachable: async () => true,
            useLiveServerWake: () => true,
            setLiveServerWakeAvailable: () => {},
        }));

        const { maybeDeliverChannel2: deliver } = await import("./channel2-delivery");
        const delivered = await deliver("ses-fail", {
            db,
            serverUrl: SERVER,
            directory: ".",
            reclaimableTokens: 30_000,
            usableTokens: 60_000,
        });

        expect(delivered).toBe(false);
        // Reverted to pending so a later event retries — the single nudge isn't lost.
        expect(getChannel2NudgeState(db, "ses-fail")).toBe("pending");
    });

    it("a second delivery attempt after success is a no-op (one nudge per lifetime)", async () => {
        useTempDataHome("ch2-twice-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-twice", "delivered");
        setLiveServerWakeAvailable(SERVER, true);
        const delivered = await maybeDeliverChannel2("ses-twice", {
            db,
            serverUrl: SERVER,
            directory: ".",
        });
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-twice")).toBe("delivered");
    });
});
