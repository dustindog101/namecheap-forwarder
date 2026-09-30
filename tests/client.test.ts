import { describe, it, expect, vi, beforeEach } from "vitest";
import { NamecheapClient } from "../src/client.js";
import { CloudflareBlockedError } from "../src/types.js";
import type { NamecheapSession } from "../src/types.js";

const response = (status: number, text: string, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => text,
});

describe("NamecheapClient", () => {
    const session: NamecheapSession = { cookies: "nc-csrf-token=my-csrf-token", csrfToken: null };
    const opts = { minIntervalMs: 0, retries: 0, baseUrl: "https://ap.www.namecheap.com" };

    beforeEach(() => {
        global.fetch = vi.fn();
    });

    it("sends cookies and the CSRF header without following redirects", async () => {
        const client = new NamecheapClient(session, "example.com", opts);
        vi.mocked(fetch).mockResolvedValueOnce(response(200, JSON.stringify({ Result: true })) as Response);

        await client.request("/test", { foo: "bar" });

        expect(fetch).toHaveBeenCalledWith(
            "https://ap.www.namecheap.com/test",
            expect.objectContaining({
                method: "POST",
                redirect: "manual",
                headers: expect.objectContaining({ Cookie: "nc-csrf-token=my-csrf-token", _nccompliance: "my-csrf-token" }),
            })
        );
    });

    it("handles cloudflare block", async () => {
        const client = new NamecheapClient(session, "example.com", opts);
        vi.mocked(fetch).mockResolvedValueOnce(response(403, "cloudflare") as Response);
        await expect(client.request("/test", {})).rejects.toThrow(CloudflareBlockedError);
    });

    it("does not treat a non-JSON 200 as success", async () => {
        const client = new NamecheapClient(session, "example.com", opts);
        vi.mocked(fetch).mockResolvedValueOnce(response(200, "<html>maintenance</html>") as Response);
        await expect(client.addForwarder("a", "b@c.com")).rejects.toThrow(/non-JSON/);
    });
});
