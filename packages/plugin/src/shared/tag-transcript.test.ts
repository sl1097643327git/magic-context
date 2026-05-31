/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ContextDatabase } from "../features/magic-context/storage";
import type { Tagger } from "../features/magic-context/tagger";
import { tagTranscript } from "./tag-transcript";
import type { Transcript, TranscriptPart, TranscriptPartKind } from "./transcript";

class FakeTagger implements Tagger {
    private nextTag = 1;
    private toolTags = new Map<string, number>();
    readonly owners: string[] = [];

    assignTag(): number {
        return this.nextTag++;
    }

    getTag(): number | undefined {
        return undefined;
    }

    assignToolTag(
        _sessionId: string,
        callId: string,
        ownerMsgId: string,
        _byteSize: number,
    ): number {
        const key = `${ownerMsgId}\0${callId}`;
        const existing = this.toolTags.get(key);
        if (existing !== undefined) return existing;
        const tag = this.nextTag++;
        this.toolTags.set(key, tag);
        this.owners.push(ownerMsgId);
        return tag;
    }

    getToolTag(_sessionId: string, callId: string, ownerMsgId: string): number | undefined {
        return this.toolTags.get(`${ownerMsgId}\0${callId}`);
    }

    bindTag(): void {}

    bindToolTag(_sessionId: string, callId: string, ownerMsgId: string, tagNumber: number): void {
        this.toolTags.set(`${ownerMsgId}\0${callId}`, tagNumber);
    }

    getAssignments(): ReadonlyMap<string, number> {
        return this.toolTags;
    }

    resetCounter(): void {
        this.nextTag = 1;
    }

    getCounter(): number {
        return this.nextTag - 1;
    }

    initFromDb(): void {}

    cleanup(): void {}
}

class TestPart implements TranscriptPart {
    constructor(
        readonly kind: TranscriptPartKind,
        readonly id: string | undefined,
        private text: string,
        private readonly toolName = "read",
    ) {}

    getText(): string | undefined {
        return this.text;
    }

    setText(newText: string): boolean {
        if (this.text === newText) return false;
        this.text = newText;
        return true;
    }

    setToolOutput(newText: string): boolean {
        return this.setText(newText);
    }

    getToolMetadata(): { toolName: string | undefined; inputByteSize: number } {
        return {
            toolName: this.toolName,
            inputByteSize: this.kind === "tool_use" ? this.text.length : 0,
        };
    }

    replaceWithSentinel(sentinelText: string): boolean {
        return this.setText(sentinelText);
    }
}

describe("tagTranscript tool aggregation", () => {
    it("keeps repeated callIds in separate owner-scoped aggregate targets", () => {
        const tagger = new FakeTagger();
        const firstUse = new TestPart("tool_use", "read:32", '{"file":"long-a"}');
        const firstResult = new TestPart("tool_result", "read:32", "r1");
        const secondUse = new TestPart("tool_use", "read:32", '{"file":"long-b"}');
        const secondResult = new TestPart("tool_result", "read:32", "r2");
        const transcript: Transcript = {
            harness: "pi",
            messages: [
                { info: { id: "assistant-1", role: "assistant" }, parts: [firstUse] },
                { info: { id: "user-1", role: "user" }, parts: [firstResult] },
                { info: { id: "assistant-2", role: "assistant" }, parts: [secondUse] },
                { info: { id: "user-2", role: "user" }, parts: [secondResult] },
            ],
            commit() {},
        };

        const { targets } = tagTranscript(
            "session-1",
            transcript,
            tagger,
            {} as ContextDatabase,
        );

        const firstTag = tagger.getToolTag("session-1", "read:32", "assistant-1");
        const secondTag = tagger.getToolTag("session-1", "read:32", "assistant-2");
        expect(firstTag).toBeDefined();
        expect(secondTag).toBeDefined();
        expect(firstTag).not.toBe(secondTag);
        expect(tagger.owners).toEqual(["assistant-1", "assistant-2"]);
        expect(targets.size).toBe(2);

        expect(targets.get(firstTag ?? -1)?.drop()).toBe("removed");
        expect(firstUse.getText()).toBe(`[dropped §${firstTag}§]`);
        expect(firstResult.getText()).toBe(`[dropped §${firstTag}§]`);
        expect(secondUse.getText()).toBe('{"file":"long-b"}');
        expect(secondResult.getText()).toContain("r2");
    });
});
