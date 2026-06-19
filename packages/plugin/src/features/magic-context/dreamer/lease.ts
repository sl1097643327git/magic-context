import type { Database } from "../../../shared/sqlite";
import { deleteDreamState, getDreamState, setDreamState } from "./storage-dream-state";

const LEASE_DURATION_MS = 2 * 60 * 1000; // 2 minutes — renewed periodically during task execution

/**
 * Dreamer v2 uses one lease PER CONFLICT-DOMAIN (memory:<project>,
 * key-files:<project>, user-memories, …) so disjoint-state tasks don't block
 * each other while the memory-mutating tasks still serialize. A lease is three
 * `dream_state` rows under a key namespace.
 *
 * `DREAMING_LEASE_KEY` is the legacy single-lease key. It keeps the original
 * `acquireLease(db, holderId)` signature working (the lease-key param defaults to
 * it) for the still-suite-based runner until the per-task scheduler replaces it.
 */
export const DREAMING_LEASE_KEY = "dreaming";

interface LeaseRowKeys {
    holder: string;
    heartbeat: string;
    expiry: string;
}

function rowKeys(leaseKey: string): LeaseRowKeys {
    // The legacy lease retains its historical un-namespaced row keys so an
    // in-flight pre-upgrade lease isn't orphaned across the boundary.
    if (leaseKey === DREAMING_LEASE_KEY) {
        return {
            holder: "dreaming_lease_holder",
            heartbeat: "dreaming_lease_heartbeat",
            expiry: "dreaming_lease_expiry",
        };
    }
    return {
        holder: `lease:${leaseKey}:holder`,
        heartbeat: `lease:${leaseKey}:heartbeat`,
        expiry: `lease:${leaseKey}:expiry`,
    };
}

function getLeaseExpiry(db: Database, keys: LeaseRowKeys): number | null {
    const value = getDreamState(db, keys.expiry);
    if (!value) {
        return null;
    }

    const expiry = Number(value);
    return Number.isFinite(expiry) ? expiry : null;
}

export function isLeaseActive(db: Database, leaseKey: string = DREAMING_LEASE_KEY): boolean {
    const expiry = getLeaseExpiry(db, rowKeys(leaseKey));
    return expiry !== null && expiry > Date.now();
}

export function getLeaseHolder(db: Database, leaseKey: string = DREAMING_LEASE_KEY): string | null {
    return getDreamState(db, rowKeys(leaseKey).holder);
}

export function peekLeaseHolderAndExpiry(
    db: Database,
    expectedHolder: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    const keys = rowKeys(leaseKey);
    const holder = getDreamState(db, keys.holder);
    if (holder !== expectedHolder) return false;
    const expiryStr = getDreamState(db, keys.expiry);
    if (!expiryStr) return false;
    const expiry = Number(expiryStr);
    return Number.isFinite(expiry) && expiry >= Date.now();
}

// The lease spans three dream_state rows (holder/heartbeat/expiry), so it can't
// be a single-statement CAS like compartment-lease.ts. Instead each mutation
// runs under BEGIN IMMEDIATE: the write lock is taken at BEGIN time (not at the
// first write, as the deferred BEGIN that db.transaction() emits would), so the
// read-then-write is atomic across the OpenCode+Pi processes that share this
// SQLite file. Without IMMEDIATE, two processes could both read isLeaseActive()
// = false under WAL snapshot isolation and both write — double-acquiring the
// lease and spawning duplicate dreamer workers. busy_timeout (set in
// initializeDatabase) makes the loser wait rather than throw SQLITE_BUSY.
function runImmediate<T>(db: Database, body: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        const result = body();
        db.exec("COMMIT");
        committed = true;
        return result;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // already rolled back / no active transaction
            }
        }
    }
}

export function acquireLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        if (isLeaseActive(db, leaseKey)) {
            const existingHolder = getLeaseHolder(db, leaseKey);
            if (existingHolder && existingHolder !== holderId) {
                return false;
            }
        }

        const now = Date.now();
        setDreamState(db, keys.holder, holderId);
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        return true;
    });
}

export function renewLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        if (getLeaseHolder(db, leaseKey) !== holderId || !isLeaseActive(db, leaseKey)) {
            return false;
        }

        const now = Date.now();
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        return true;
    });
}

export function releaseLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): void {
    const keys = rowKeys(leaseKey);
    runImmediate(db, () => {
        if (getLeaseHolder(db, leaseKey) !== holderId) {
            return;
        }

        deleteDreamState(db, keys.holder);
        deleteDreamState(db, keys.heartbeat);
        deleteDreamState(db, keys.expiry);
    });
}
