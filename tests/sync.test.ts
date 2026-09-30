import { describe, it, expect, vi } from "vitest";
import { planSync, syncForwarders, normalizeDesiredForwards } from "../src/sync.js";
import type { NamecheapClientLike } from "../src/types.js";

const ok = { alreadyExisted: false, raw: { Result: true } };

describe("syncForwarders", () => {
    it("adds missing, deletes obsolete, keeps identical — adds before removals", async () => {
        const calls: string[] = [];
        const mockClient: NamecheapClientLike = {
            listForwarders: async () => [
                { alias: "keep", forwardTo: "keep@test.com" },
                { alias: "remove", forwardTo: "remove@test.com" },
                { alias: "update", forwardTo: "old@test.com" },
            ],
            addForwarder: vi.fn(async (a: string) => (calls.push(`add:${a}`), ok)),
            deleteForwarder: vi.fn(async (a: string) => (calls.push(`del:${a}`), ok)),
        };

        const summary = await syncForwarders(mockClient, { keep: "keep@test.com", add: "add@test.com", update: "new@test.com" });

        expect(calls).toEqual(["add:add", "add:update", "del:remove", "del:update"]);
        expect(summary.added.length).toBe(2);
        expect(summary.removed.length).toBe(2);
        expect(summary.unchanged).toEqual([{ alias: "keep", forwardTo: "keep@test.com" }]);
        expect(summary.errors.length).toBe(0);
    });

    it("does not report a failed removal as removed", async () => {
        const mockClient: NamecheapClientLike = {
            listForwarders: async () => [{ alias: "x", forwardTo: "x@test.com" }],
            addForwarder: vi.fn(async () => ok),
            deleteForwarder: vi.fn(async () => {
                throw new Error("nope");
            }),
        };
        const summary = await syncForwarders(mockClient, {});
        expect(summary.removed).toEqual([]);
        expect(summary.errors).toEqual([{ op: "remove", alias: "x", forwardTo: "x@test.com", error: "nope" }]);
    });

    it("dry run makes no calls", async () => {
        const mockClient: NamecheapClientLike = {
            listForwarders: async () => [{ alias: "x", forwardTo: "x@test.com" }],
            addForwarder: vi.fn(),
            deleteForwarder: vi.fn(),
        };
        const summary = await syncForwarders(mockClient, { y: "y@test.com" }, { dryRun: true });
        expect(mockClient.addForwarder).not.toHaveBeenCalled();
        expect(mockClient.deleteForwarder).not.toHaveBeenCalled();
        expect(summary.added).toHaveLength(1);
        expect(summary.removed).toHaveLength(1);
    });
});

describe("planSync", () => {
    const existing = [
        { alias: "Support", forwardTo: "Team@Test.com" },
        { alias: "*", forwardTo: "all@test.com" },
    ];

    it("compares case-insensitively and preserves destination casing", () => {
        const plan = planSync(existing, { support: "team@test.com", new: "New.Person@Test.com" });
        expect(plan.unchanged).toHaveLength(1);
        expect(plan.toAdd).toEqual([{ alias: "new", forwardTo: "New.Person@Test.com" }]);
        expect(plan.toRemove).toEqual([{ alias: "*", forwardTo: "all@test.com" }]);
    });

    it("honours prune: false and keep", () => {
        expect(planSync(existing, {}, { prune: false }).toRemove).toEqual([]);
        expect(planSync(existing, {}, { keep: ["*"] }).toRemove).toEqual([{ alias: "Support", forwardTo: "Team@Test.com" }]);
    });

    it("validates the desired map", () => {
        expect(() => normalizeDesiredForwards({ "bad alias": "a@b.com" })).toThrow(/Invalid alias/);
        expect(() => normalizeDesiredForwards({ ok: "nope" })).toThrow(/Invalid destination/);
        expect(() => normalizeDesiredForwards([] as never)).toThrow(/must be an object/);
        expect(normalizeDesiredForwards({ a: ["x@y.com", "X@Y.com"] })).toHaveLength(1);
    });
});

it("preserves old destinations when replacement adds fail, while independent removals proceed", async () => {
    const client: NamecheapClientLike = {
        listForwarders: async () => [{ alias: "Support", forwardTo: "old@test.com" }, { alias: "obsolete", forwardTo: "x@test.com" }],
        addForwarder: vi.fn(async () => { throw new Error("Limit reached"); }),
        deleteForwarder: vi.fn(async () => ok),
    };
    const result = await syncForwarders(client, { support: "new@test.com" });
    expect(client.deleteForwarder).toHaveBeenCalledExactlyOnceWith("obsolete", "x@test.com");
    expect(result.removed).toEqual([{ alias: "obsolete", forwardTo: "x@test.com" }]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[1]).toMatchObject({ op: "remove", alias: "Support" });
});
