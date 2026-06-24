import { describe, expect, test } from "bun:test";

import { createPinnedLookup, type SmartNoteResolver, validateSmartNoteHttpUrl } from "./ssrf-guard";

const signal = new AbortController().signal;

function resolver(rows: Array<{ address: string; family: 4 | 6 }>): SmartNoteResolver {
    return { lookup: async () => rows };
}

describe("smart-note SSRF guard", () => {
    test("requires https", async () => {
        await expect(validateSmartNoteHttpUrl("http://example.com", { signal })).rejects.toThrow(
            /https/i,
        );
        await expect(validateSmartNoteHttpUrl("file:///etc/passwd", { signal })).rejects.toThrow();
    });

    test("blocks alternate IPv4 loopback encodings canonicalized by URL", async () => {
        for (const host of ["127.1", "0177.0.0.1", "0x7f.0.0.1", "2130706433"]) {
            await expect(validateSmartNoteHttpUrl(`https://${host}/`, { signal })).rejects.toThrow(
                /non-global|internal/i,
            );
        }
    });

    test("blocks private, link-local, metadata, CGNAT, multicast, and documentation IPv4", async () => {
        for (const address of [
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "169.254.1.10",
            "100.64.0.1",
            "224.0.0.1",
            "192.0.2.10",
            "198.51.100.10",
            "203.0.113.10",
        ]) {
            await expect(
                validateSmartNoteHttpUrl(`https://${address}/`, { signal }),
            ).rejects.toThrow(/non-global|internal/i);
        }
    });

    test("blocks IPv4-mapped and private IPv6 ranges", async () => {
        for (const host of [
            "[::1]",
            "[::ffff:127.0.0.1]",
            "[fe80::1]",
            "[fc00::1]",
            "[fd00:ec2::254]",
            "[ff02::1]",
            "[2001:db8::1]",
        ]) {
            await expect(validateSmartNoteHttpUrl(`https://${host}/`, { signal })).rejects.toThrow(
                /non-global|internal/i,
            );
        }
    });

    test("rejects DNS answers with any private address", async () => {
        await expect(
            validateSmartNoteHttpUrl("https://example.test/", {
                signal,
                resolver: resolver([
                    { address: "93.184.216.34", family: 4 },
                    { address: "10.0.0.2", family: 4 },
                ]),
            }),
        ).rejects.toThrow(/non-global|internal/i);
    });

    test("allows public DNS answers and preserves all validated candidates", async () => {
        const validated = await validateSmartNoteHttpUrl("https://example.test/path", {
            signal,
            resolver: resolver([
                { address: "93.184.216.34", family: 4 },
                { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
            ]),
        });
        expect(validated.addresses.map((a) => a.address)).toEqual([
            "93.184.216.34",
            "2606:2800:220:1:248:1893:25c8:1946",
        ]);
    });
});

describe("createPinnedLookup", () => {
    // Regression: Node 20+ https.request defaults to autoSelectFamily
    // (Happy-Eyeballs), which calls the lookup hook with { all: true } and
    // expects the ARRAY callback form. The original hook only ever used the
    // 3-arg form, so Node's lookupAndConnectMultiple ran results.sort() on
    // undefined → "results.sort is not a function" broke every network check.
    test("returns the ARRAY form when Node asks for all candidates", () => {
        const hook = createPinnedLookup({ address: "93.184.216.34", family: 4 });
        let received: unknown;
        hook("example.test", { all: true }, (err, addresses) => {
            expect(err).toBeNull();
            received = addresses;
        });
        expect(received).toEqual([{ address: "93.184.216.34", family: 4 }]);
    });

    test("returns the legacy 3-arg form when all is not requested", () => {
        const hook = createPinnedLookup({ address: "2606:2800:220:1::1", family: 6 });
        let addr: unknown;
        let fam: unknown;
        hook("example.test", {}, (err, address, family) => {
            expect(err).toBeNull();
            addr = address;
            fam = family;
        });
        expect(addr).toBe("2606:2800:220:1::1");
        expect(fam).toBe(6);
    });

    test("pins to the validated IP without re-querying DNS", () => {
        const hook = createPinnedLookup({ address: "203.0.113.7", family: 4 });
        // Even though the hostname differs, the hook must return the pinned IP.
        let received: unknown;
        hook("attacker-rebind.test", { all: true }, (_err, addresses) => {
            received = addresses;
        });
        expect(received).toEqual([{ address: "203.0.113.7", family: 4 }]);
    });
});
