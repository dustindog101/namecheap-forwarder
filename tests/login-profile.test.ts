import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { loadLoginProfile, saveLoginProfile, credentialPath } from "../src/login-profile.js";

it("stores credentials privately per profile, replaces insecure files, and keeps sessions separate", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ncf-profile-"));
    const manager = new SessionManager(dir);
    try {
        const profile = { username: "fixture", password: "fixture-password" };
        expect(await loadLoginProfile(manager, "default")).toBeNull();
        await fs.writeFile(credentialPath(manager, "default"), "{}", { mode: 0o644 });
        await saveLoginProfile(manager, "default", profile);
        expect((await fs.stat(credentialPath(manager, "default"))).mode & 0o777).toBe(0o600);
        expect(await loadLoginProfile(manager, "default")).toEqual(profile);
        expect(await loadLoginProfile(manager, "other")).toBeNull();
        expect(await manager.loadSession()).toBeNull();
        expect(() => credentialPath(manager, "../bad")).toThrow();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it("rejects corrupt stored secrets without including their contents in the error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ncf-corrupt-"));
    const manager = new SessionManager(dir);
    try {
        await fs.writeFile(credentialPath(manager, "default"), '{"password":"fixture-do-not-log"');
        await expect(loadLoginProfile(manager, "default")).rejects.toThrow("Invalid JSON");
        try { await loadLoginProfile(manager, "default"); } catch (error) { expect(String(error)).not.toContain("fixture-do-not-log"); }
        await fs.writeFile(credentialPath(manager, "default"), JSON.stringify({ username: "u", password: 123 }));
        await expect(loadLoginProfile(manager, "default")).rejects.toThrow("Invalid saved login profile");
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
