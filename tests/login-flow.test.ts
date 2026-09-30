import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { loginAccount } from "../src/login.js";
import { loadLoginProfile, saveLoginProfile } from "../src/login-profile.js";
import { parseTotp } from "../src/totp.js";

let dir: string;
let manager: SessionManager;
const session = { cookies: "fixture=good", csrfToken: "fixture" };
const log = () => {};
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "ncf-flow-")); manager = new SessionManager(dir); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

it("saves privately prompted credentials by default after successful headless login", async () => {
    const prompt = vi.fn().mockResolvedValueOnce("fixture-user").mockResolvedValueOnce("fixture-password");
    const login = vi.spyOn(manager, "login").mockImplementation(async options => {
        expect(options?.headless).toBe(true);
        expect(await options!.promptCredentials!()).toEqual({ username: "fixture-user", password: "fixture-password" });
        return session;
    });
    expect((await loginAccount({ env: {}, prompt, log }, manager)).credentialsSaved).toBe(true);
    expect(login).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenNthCalledWith(2, "Namecheap password (hidden): ", true);
    expect(await loadLoginProfile(manager, "default")).toMatchObject({ username: "fixture-user", password: "fixture-password" });
});

it("skips the browser and prompts when the saved session validates", async () => {
    await manager.saveSession(session);
    vi.spyOn(manager, "checkSession").mockResolvedValue(true);
    const login = vi.spyOn(manager, "login");
    const prompt = vi.fn();
    const result = await loginAccount({ env: {}, prompt, log }, manager);
    expect(result.reused).toBe(true);
    expect(login).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
});

it("uses saved credentials and TOTP when the session expires", async () => {
    const totp = parseTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    await saveLoginProfile(manager, "work", { username: "u", password: "p", totp });
    await manager.saveSession(session, "work");
    vi.spyOn(manager, "checkSession").mockResolvedValue(false);
    const login = vi.spyOn(manager, "login").mockResolvedValue(session);
    await loginAccount({ profile: "work", env: {}, interactive: false, log }, manager);
    expect(login).toHaveBeenCalledWith(expect.objectContaining({ username: "u", password: "p", totp, headless: true }));
    expect(await loadLoginProfile(manager, "default")).toBeNull();
});

it("does not mix a different environment account with saved password or TOTP", async () => {
    await saveLoginProfile(manager, "default", { username: "old", password: "old-password", totp: parseTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") });
    const prompt = vi.fn(async () => "new-password");
    vi.spyOn(manager, "login").mockImplementation(async options => {
        expect(options?.password).toBeUndefined();
        expect(options?.totp).toBeUndefined();
        expect(options?.fresh).toBe(true);
        await options!.promptCredentials!();
        return session;
    });
    await loginAccount({ env: { NAMECHEAP_USERNAME: "new" }, prompt, log }, manager);
    expect(await loadLoginProfile(manager, "default")).toEqual({ username: "new", password: "new-password", totp: undefined });
});

it("honors no-save and does not persist credentials after failure", async () => {
    const login = vi.spyOn(manager, "login").mockResolvedValue(session);
    await loginAccount({ env: { NAMECHEAP_USERNAME: "u", NAMECHEAP_PASSWORD: "p" }, saveCredentials: false, log }, manager);
    expect(await loadLoginProfile(manager, "default")).toBeNull();
    login.mockRejectedValue(new Error("Rejected"));
    await expect(loginAccount({ env: { NAMECHEAP_USERNAME: "u", NAMECHEAP_PASSWORD: "bad" }, log }, manager)).rejects.toThrow("Rejected");
    expect(await loadLoginProfile(manager, "default")).toBeNull();
});

it("fails unattended prompts promptly with an actionable login hint", async () => {
    vi.spyOn(manager, "login").mockImplementation(async options => { await options!.promptCredentials!(); return session; });
    await expect(loginAccount({ env: {}, interactive: false, log }, manager)).rejects.toThrow("ncf login");
});
