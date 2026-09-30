import { describe, expect, it } from "vitest";
import { chooseDomain, collectDomains, parseDomainPage } from "../src/domains.js";
const row = (domain: string) => ({ domain, expiresAt: null, autoRenew: false, blocked: false });
describe("account domains", () => {
    it("normalizes metadata and rejects malformed account responses", () => {
        expect(parseDomainPage(JSON.stringify({ Data: [{ DomainName: "EXAMPLE.com", AutoRenew: true, IsBlocked: true, ExpireDateTime: "2027-01-01" }], TotalItems: 1 }))).toEqual({ domains: [{ domain: "example.com", autoRenew: true, blocked: true, expiresAt: "2027-01-01T00:00:00.000Z" }], total: 1 });
        for (const text of ["null", "{}", '{"Data":[],"TotalItems":-1}', '{"Data":[{}],"TotalItems":1}']) expect(() => parseDomainPage(text)).toThrow();
    });
    it("collects every page, deduplicates and fails closed when paging stalls", async () => {
        const calls: number[] = [];
        const result = await collectDomains(async page => { calls.push(page); return { domains: page === 1 ? [row("b.test")] : [row("b.test"), row("a.test")], total: 2 }; });
        expect(calls).toEqual([1, 2]);
        expect(result.map(x => x.domain)).toEqual(["a.test", "b.test"]);
        await expect(collectDomains(async () => ({ domains: [row("a.test")], total: 2 }))).rejects.toThrow(/did not advance/);
    });
    it("selects exact or unique names and refuses ambiguity", () => {
        const rows = [row("alpha.test"), row("beta.test")];
        expect(chooseDomain(rows, "ALPHA.TEST").domain).toBe("alpha.test");
        expect(chooseDomain(rows, "beta").domain).toBe("beta.test");
        expect(() => chooseDomain(rows, "test")).toThrow(/Several/);
        expect(() => chooseDomain(rows, "missing")).toThrow(/No account domain/);
        expect(() => chooseDomain(rows, " ")).toThrow(/Enter/);
    });
});
