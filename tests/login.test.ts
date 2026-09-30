import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../src/session-manager.js";
import { generateTotp, parseTotp } from "../src/totp.js";

const launch = vi.hoisted(() => vi.fn());
vi.mock("../src/playwright.js", () => ({ launchChromium: launch }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function browserFixture(challenge: string) {
    let url = "https://www.namecheap.com/myaccount/login/";
    let submits = 0;
    const fills: string[] = [];
    const field = {
        first() { return this; },
        waitFor: vi.fn(async () => {}),
        fill: vi.fn(async (value: string) => { fills.push(value); }),
        click: vi.fn(async () => { url = ++submits === 1 ? "https://www.namecheap.com/myaccount/twofa/" : "https://ap.www.namecheap.com/domains/"; }),
        innerText: vi.fn(async () => challenge),
    };
    const page = {
        goto: vi.fn(async () => {}), waitForLoadState: vi.fn(async () => {}),
        url: () => url, locator: () => field,
        waitForURL: vi.fn(async (predicate: (url: URL) => boolean) => { if (!predicate(new URL(url))) throw new Error("unexpected URL"); }),
        evaluate: vi.fn(async () => "fixture-csrf"),
    };
    const context = { newPage: async () => page, cookies: async () => [{ name: "fixture", value: "test" }], storageState: async () => ({ cookies: [], origins: [] }) };
    const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
    launch.mockResolvedValue(browser);
    return { fills, browser };
}

it("uses private credential prompts and generates TOTP for an authenticator challenge in a hidden browser", async () => {
    vi.spyOn(Date, "now").mockReturnValue(59_000);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ncf-login-"));
    try {
        const { fills, browser } = browserFixture("Enter the code from your authenticator app");
        const totp = parseTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        const promptCode = vi.fn();
        await new SessionManager(dir).login({ headless: true, fresh: true, totp, promptCode, promptCredentials: async () => ({ username: "test-user", password: "test-password" }), log: () => {} });
        expect(launch).toHaveBeenCalledWith({ headless: true });
        expect(fills).toEqual(["test-user", "test-password", generateTotp(totp, 59_000)]);
        expect(promptCode).not.toHaveBeenCalled();
        expect(browser.close).toHaveBeenCalled();
        expect(await new SessionManager(dir).loadSession()).not.toBeNull();
    } finally { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); }
});

it("asks for device/email codes instead of sending saved TOTP", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ncf-login-"));
    try {
        const { fills } = browserFixture("Device verification: code sent to your email");
        const promptCode = vi.fn(async () => "123456");
        await new SessionManager(dir).login({ headless: true, username: "u", password: "p", totp: parseTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), promptCode, log: () => {} });
        expect(promptCode).toHaveBeenCalledOnce();
        expect(fills).toEqual(["u", "p", "123456"]);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it("recognizes the real TOTP route before dynamic page text has loaded", async () => {
    const { isAuthenticatorChallenge } = await import("../src/session-manager.js");
    expect(isAuthenticatorChallenge("https://www.namecheap.com/twofa/totp/", "")).toBe(true);
    expect(isAuthenticatorChallenge("https://www.namecheap.com/twofa/device/", "Use an authenticator app for other methods")).toBe(false);
    expect(isAuthenticatorChallenge("invalid", "authenticator")).toBe(false);
});
