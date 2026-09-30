import { createSessionJar, exportJarSession } from "./cookie-jar.js";
import { generateTotp, type TotpConfig } from "./totp.js";
import { readPrivateJson, writePrivateJson, removePrivateFile } from "./private-store.js";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { BrowserContext, Page } from "playwright-core";
import { getSessionAgeHours, resolveCsrfToken } from "./helpers.js";
import { isLoginUrl, isCloudflareBlock, isLoginRedirect } from "./parse.js";
import { launchChromium } from "./playwright.js";
import { CloudflareBlockedError, SessionExpiredError, type StealthSession } from "./types.js";

const LOGIN_URL = "https://www.namecheap.com/myaccount/login/";
const DASHBOARD_URL = "https://ap.www.namecheap.com/domains/";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

export type LoginOptions = {
    /** Saved-session name, for multiple Namecheap accounts. Default "default". */
    profile?: string;
    fresh?: boolean;
    totp?: TotpConfig;
    promptCredentials?: () => Promise<{ username: string; password: string }>;
    username?: string;
    password?: string;
    /** Run without a visible window. Requires username + password. */
    headless?: boolean;
    /** Asks for the 2FA / device-verification code in headless mode. Defaults to a terminal prompt. */
    promptCode?: (message: string) => Promise<string>;
    /** Progress messages. Defaults to stderr. */
    log?: (message: string) => void;
};

function promptTerminal(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function defaultSessionDir(): string {
    if (process.env.NAMECHEAP_SESSION_DIR) return process.env.NAMECHEAP_SESSION_DIR;
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(configHome, "namecheap-forwarder");
}

/**
 * Navigates without failing on slow pages: Cloudflare checks and heavy dashboards can take longer
 * than a load event allows, and the following URL checks decide what happens next anyway.
 */
async function gotoTolerant(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "commit", timeout: 60_000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
}

const isVerificationUrl = (url: string) => /twofa|verification|device/i.test(url);

export function isAuthenticatorChallenge(url: string, text: string): boolean {
    let pathname: string;
    try { pathname = new URL(url).pathname; } catch { return false; }
    if (/\/twofa\/totp(?:\/|$)/i.test(pathname)) return true;
    if (/device|email|sms/i.test(pathname)) return false;
    return /authenticator|authentication app|google auth|totp/i.test(text) && !/sent.{0,60}(email|phone|sms)/i.test(text);
}
const isDashboardUrl = (url: string) => {
    try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname === "ap.www.namecheap.com" && !isLoginUrl(parsed.pathname); }
    catch { return false; }
};

/**
 * Stores Namecheap sessions (cookies, CSRF token, browser storage state) on disk and
 * captures new ones through a real browser login.
 *
 * A session belongs to a Namecheap account, not a domain: one login works for every
 * domain in the account. Use profiles to keep several accounts apart.
 */
export class SessionManager {
    readonly sessionDir: string;

    constructor(sessionDir?: string) {
        this.sessionDir = sessionDir ?? defaultSessionDir();
    }

    /**
     * Session from NAMECHEAP_SESSION_COOKIES (+ NAMECHEAP_NCCOMPLIANCE_TOKEN), for CI and serverless.
     */
    static fromEnv(env: NodeJS.ProcessEnv = process.env): StealthSession | null {
        const cookies = env.NAMECHEAP_SESSION_COOKIES;
        if (!cookies) return null;
        return {
            cookies,
            csrfToken: resolveCsrfToken(env.NAMECHEAP_NCCOMPLIANCE_TOKEN ?? env.NAMECHEAP_CSRF_TOKEN, cookies),
        };
    }

    getSessionPath(profile = "default"): string {
        if (!/^[\w.-]+$/.test(profile)) throw new Error(`Invalid profile name "${profile}"`);
        return path.join(this.sessionDir, `${profile}.session.json`);
    }

    async loadSession(profile = "default"): Promise<StealthSession | null> {
        const value = await readPrivateJson(this.getSessionPath(profile));
        if (value === null) return null;
        const session = value as StealthSession;
        if (!session || typeof session.cookies !== "string" || !session.cookies || (session.csrfToken !== null && typeof session.csrfToken !== "string")) {
            throw new Error("Invalid saved session. Run ncf logout --session-only, then ncf login.");
        }
        return session;
    }

    async saveSession(session: StealthSession, profile = "default"): Promise<string> {
        const file = this.getSessionPath(profile);
        await writePrivateJson(file, { ...session, savedAt: session.savedAt ?? new Date().toISOString() });
        return file;
    }

    async deleteSession(profile = "default"): Promise<boolean> {
        return removePrivateFile(this.getSessionPath(profile));
    }

    /** Fast read-only probe. null means a browser is needed to resolve the response. */
    async checkSession(session: StealthSession): Promise<boolean | null> {
        const dashboardUrl = new URL("/domains/", process.env.NAMECHEAP_BASE_URL || DASHBOARD_URL).href;
        const jar = createSessionJar(session, dashboardUrl);
        let url = dashboardUrl;
        try {
            for (let hop = 0; hop < 4; hop++) {
                const response = await fetch(url, {
                    headers: { Cookie: jar.getCookieStringSync(url), "User-Agent": USER_AGENT },
                    redirect: "manual", signal: AbortSignal.timeout(10_000),
                });
                for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, url, { ignoreError: true });
                const location = response.headers.get("location");
                if (response.status >= 300 && response.status < 400 && location) {
                    const target = new URL(location, url);
                    if (isLoginUrl(target.pathname)) return false;
                    if (target.origin !== new URL(dashboardUrl).origin) return null;
                    url = target.href;
                    continue;
                }
                if (response.status === 401) return false;
                if (response.status !== 200) return null;
                const text = await response.text();
                if (isCloudflareBlock(text)) return null;
                if (isLoginRedirect(text)) return false;
                if (!/(?:log\s*out|sign\s*out|myaccount\/logout)/i.test(text)) return null;
                Object.assign(session, exportJarSession(jar, dashboardUrl, session.csrfToken, session));
                return true;
            }
            return null;
        } catch { return null; }
    }

    async getSessionAgeHours(profile = "default"): Promise<number> {
        const session = await this.loadSession(profile);
        return getSessionAgeHours(session?.savedAt);
    }

    /**
     * Opens a browser, reuses the saved session if Namecheap still accepts it, otherwise logs in.
     * Without credentials a visible browser opens and you sign in (and complete 2FA) yourself.
     */
    async login(options: LoginOptions = {}): Promise<StealthSession> {
        const { profile = "default" } = options;
        let { username, password } = options;
        const log = options.log ?? ((m: string) => console.error(m));
        const promptCode = options.promptCode ?? promptTerminal;
        const headless = options.headless ?? true;

        const existing = options.fresh ? null : await this.loadSession(profile);
        const browser = await launchChromium({ headless });
        try {
            const context = await browser.newContext({
                userAgent: USER_AGENT,
                ...(existing?.storageState ? { storageState: existing.storageState as never } : {}),
            });
            const page = await context.newPage();

            await gotoTolerant(page, DASHBOARD_URL);
            if (isCloudflareBlock(await page.locator("body").innerText())) throw new CloudflareBlockedError();
            if (isDashboardUrl(page.url())) {
                log("Saved session is still valid — refreshed it.");
                return await this.capture(context, page, profile);
            }

            if (!page.url().includes("myaccount/login") && !isVerificationUrl(page.url())) {
                await gotoTolerant(page, LOGIN_URL);
            }

            if (headless && (!username || !password)) {
                if (!options.promptCredentials) throw new Error("Terminal login requires username and password.");
                ({ username, password } = await options.promptCredentials());
            }
            if (username && password && isLoginUrl(page.url()) && !isVerificationUrl(page.url())) {
                log("Signing in...");
                const userField = page.locator('input[name="LoginUserName"]:visible').first();
                await userField.waitFor({ state: "visible", timeout: 15_000 });
                await userField.fill(username!);
                await page.locator('input[name="LoginPassword"]:visible').first().fill(password!);
                await page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first().click();
                await page.waitForURL((url) => isDashboardUrl(url.href) || isVerificationUrl(url.href) || !url.href.includes("myaccount/login"), {
                    timeout: 30_000,
                }).catch(() => {});
            } else if (!headless) {
                log("Sign in to Namecheap in the browser window (including any 2FA). Waiting up to 5 minutes...");
            }

            if (headless && isVerificationUrl(page.url())) {
                // Generate only for an authenticator challenge, never for email/device verification.
                const challenge = await page.locator("body").innerText();
                const authenticator = isAuthenticatorChallenge(page.url(), challenge);
                const codeInput = page.locator('input[autocomplete="one-time-code"]:visible, input[type="text"]:visible:not([name="LoginUserName"]):not([name="q"]), input[type="tel"]:visible, input[type="number"]:visible').first();
                await codeInput.waitFor({ state: "visible", timeout: 30_000 });
                let code: string;
                if (options.totp && authenticator) {
                    const remaining = options.totp.period - (Date.now() / 1000 % options.totp.period);
                    if (remaining < 5) await new Promise(resolve => setTimeout(resolve, (remaining + 1) * 1000));
                    code = generateTotp(options.totp);
                    log("Submitting authenticator code.");
                } else code = await promptCode("Namecheap verification code (hidden): ");
                await codeInput.fill(code);
                await page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first().click();
            }

            // After sign-in Namecheap may land on www.namecheap.com; the dashboard lives on ap.www.
            await page
                .waitForURL(
                    (url) =>
                        !isVerificationUrl(url.href) &&
                        (isDashboardUrl(url.href) || /namecheap\.com\/(dashboard|myaccount\/(?!login))/i.test(url.href)),
                    {
                    timeout: headless ? 60_000 : 300_000,
                })
                .catch(() => {
                    throw new SessionExpiredError("Namecheap rejected or did not complete sign-in. Check credentials and authenticator setup, or try ncf login --browser.");
                });
            if (!isDashboardUrl(page.url())) {
                await gotoTolerant(page, DASHBOARD_URL);
            }
            if (!isDashboardUrl(page.url())) throw new SessionExpiredError("Namecheap rejected or did not complete sign-in. Check credentials and authenticator setup, or try ncf login --browser.");

            return await this.capture(context, page, profile);
        } catch (error) {
            if (error instanceof Error && error.name === "TimeoutError") {
                throw new SessionExpiredError("Namecheap login did not complete. Check your credentials or challenge, then try ncf login --browser.");
            }
            throw error;
        } finally {
            await browser.close().catch(() => {});
        }
    }

    private async capture(context: BrowserContext, page: Page, profile: string): Promise<StealthSession> {
        const cookieString = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
        const metaToken = await page.evaluate(() => {
            const meta = document.querySelector('input[name="ncCompliance"], input[name="_nccompliance"], meta[name="ncCompliance"], meta[name="_nccompliance"]');
            return meta?.getAttribute("value") ?? meta?.getAttribute("content") ?? null;
        });
        const session: StealthSession = {
            cookies: cookieString,
            csrfToken: resolveCsrfToken(metaToken, cookieString),
            storageState: (await context.storageState()) as unknown as Record<string, unknown>,
            savedAt: new Date().toISOString(),
        };
        await this.saveSession(session, profile);
        return session;
    }
}
