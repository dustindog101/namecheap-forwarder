import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../src/session-manager.js";

afterEach(() => vi.unstubAllGlobals());

it("follows same-origin dashboard redirects and retains rotated cookies on the fast path", async () => {
    const fetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/Domains/DomainOnly", "set-cookie": "rotated=ready; Path=/" } }))
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/domains/list" } }))
        .mockResolvedValueOnce(new Response("<a>Sign out</a>", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const session = { cookies: "auth=good", csrfToken: null };
    expect(await new SessionManager().checkSession(session)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[1][1].headers.Cookie).toContain("rotated=ready");
    expect(session.cookies).toContain("rotated=ready");
});

it("never forwards account cookies to a foreign redirect", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://foreign.example/domains/" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await new SessionManager().checkSession({ cookies: "auth=good", csrfToken: null })).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
});

it("detects an expired session without following login redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://www.namecheap.com/myaccount/login/" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await new SessionManager().checkSession({ cookies: "auth=old", csrfToken: null })).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
});

it("writes sessions atomically with owner-only permissions and rejects corrupt data", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ncf-session-"));
    const manager = new SessionManager(dir);
    try {
        await fs.writeFile(manager.getSessionPath(), "{}", { mode: 0o644 });
        await manager.saveSession({ cookies: "fixture=good", csrfToken: null });
        expect((await fs.stat(manager.getSessionPath())).mode & 0o777).toBe(0o600);
        expect(await manager.loadSession()).toMatchObject({ cookies: "fixture=good" });
        await fs.writeFile(manager.getSessionPath(), "null");
        await expect(manager.loadSession()).resolves.toBeNull();
        await fs.writeFile(manager.getSessionPath(), "[]");
        await expect(manager.loadSession()).rejects.toThrow("Invalid saved session");
        expect(await manager.deleteSession()).toBe(true);
        expect(await manager.deleteSession()).toBe(false);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
