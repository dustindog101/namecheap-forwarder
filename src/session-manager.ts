import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type { StealthSession } from "./types.js";
import { parseCookieString, resolveCsrfToken, getSessionAgeHours } from "./helpers.js";
import { generateTotp, secondsRemaining } from "./totp.js";
import { resolveTotpSecret } from "./totp-store.js";

const LOGIN_URL = "https://www.namecheap.com/myaccount/login/";
const DASHBOARD_URL = "https://ap.www.namecheap.com/domains/";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

/**
 * Namecheap's 2FA gate lives at /twofa/<method>/. The TOTP screen renders as a
 * <form class="gb-totp-form"> whose only fields are an unnamed
 * <input type="tel" placeholder="Enter OTP Code"> and its own Submit button.
 *
 * Both details matter: the code field is `type="tel"` (so `input[type="text"]`
 * misses it) and the page's first `button[type="submit"]` is the header's
 * "Sign in" nav control, NOT the form's "Submit" (so a naive .first() click
 * submits nothing). Always scope selectors to the form.
 */
const OTP_FORM = "form.gb-totp-form";
const OTP_INPUT = 'input[placeholder="Enter OTP Code"]';
const OTP_INPUT_IN_FORM = `${OTP_FORM} input[type="tel"]`;
const OTP_SUBMIT_IN_FORM = `${OTP_FORM} button[type="submit"]`;
const OTP_SUBMIT_NEAR_INPUT = `form:has(${OTP_INPUT}) button[type="submit"]`;

/**
 * The sign-in form's real submit control. The page also renders a header
 * "Sign in" <button type="submit"> that does not submit this form, so a bare
 * `button[type="submit"]` .first() can silently do nothing.
 */
const LOGIN_SUBMIT = 'input[type="submit"][name*="LoginButton"]';
const LOGIN_SUBMIT_FALLBACK = 'button[type="submit"]:visible, input[type="submit"]:visible';

/** Refresh the TOTP window if fewer than this many seconds remain before submitting. */
const MIN_TOTP_VALIDITY_SECONDS = 10;

/** How long to wait for the 2FA verdict after submitting a code. */
const OTP_VERDICT_TIMEOUT_MS = 20_000;

/** Consecutive TOTP submissions allowed before giving up (rejected codes are rate-limited upstream). */
const MAX_TOTP_ATTEMPTS = 2;

/** Keeps the automation flag out of the most trivial fingerprint. */
const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];

export type TwoFactorMethod = "totp" | "manual";

export type LoginOptions = {
    username?: string;
    password?: string;
    /** Explicitly request headless. Defaults to headless only when the login can be fully unattended. */
    headless?: boolean;
    /** Force a visible browser, e.g. to complete 2FA by hand. */
    headed?: boolean;
    env?: NodeJS.ProcessEnv;
};

function promptTerminal(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

const isAuthenticatedUrl = (href: string) =>
    href.includes("ap.www.namecheap.com") && !href.includes("login") && !href.includes("twofa");

const isTwoFactorUrl = (href: string) => href.includes("/twofa/");
const isTotpUrl = (href: string) => /\/twofa\/[^/]*totp/i.test(href);

export class SessionManager {
    constructor(private sessionDir: string = process.cwd()) {}

    getSessionPath(domain: string): string {
        return path.join(this.sessionDir, `${domain}.session.json`);
    }

    getAuthStatePath(domain: string): string {
        return path.join(this.sessionDir, `${domain}.auth-state.json`);
    }

    async loadSession(domain: string): Promise<StealthSession | null> {
        try {
            const filePath = this.getSessionPath(domain);
            const data = await fs.readFile(filePath, "utf-8");
            const session = JSON.parse(data) as StealthSession;
            return session;
        } catch {
            return null;
        }
    }

    async saveSession(domain: string, session: StealthSession): Promise<void> {
        session.savedAt = new Date().toISOString();
        await fs.mkdir(this.sessionDir, { recursive: true });
        await fs.writeFile(this.getSessionPath(domain), JSON.stringify(session, null, 2));
    }

    async isSessionValid(domain: string, maxAgeHours: number = 72): Promise<boolean> {
        const session = await this.loadSession(domain);
        if (!session || !session.cookies) return false;
        const age = getSessionAgeHours(session.savedAt);
        return age <= maxAgeHours;
    }

    /**
     * Logs in and captures the session. When a TOTP seed is available the 2FA
     * gate is cleared automatically, so the whole flow can run headless.
     */
    async interactiveLogin(domain: string, options: LoginOptions = {}): Promise<StealthSession> {
        const { username, password, headed = false, env = process.env } = options;
        const totp = await resolveTotpSecret(domain, this.sessionDir, env);

        // Unattended requires credentials AND a way through 2FA without a terminal.
        const canRunUnattended = Boolean(username && password && totp);
        const headless = headed ? false : (options.headless ?? canRunUnattended);

        if (headless && !username) {
            throw new Error(
                "Headless login needs NAMECHEAP_USERNAME and NAMECHEAP_PASSWORD in the environment.",
            );
        }

        const browser = await chromium.launch({ headless, args: LAUNCH_ARGS });
        const interactive = !headless;

        // A fresh login needs a clean context. Reusing a previously captured
        // storage state restores the old session, which makes Namecheap skip
        // the sign-in form entirely and leaves the credential step with nothing
        // to fill. Clearance cookies are re-earned on demand; a stale session is
        // not worth the broken flow.
        const context = await browser.newContext({ userAgent: USER_AGENT });
        const page = await context.newPage();

        try {
            console.log(`🌐 Opening Namecheap login page for ${domain}...`);
            await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

            // If credentials are provided and we are on login page, fill them
            if (username && password && page.url().toLowerCase().includes("login")) {
                try {
                    console.log("🔑 Entering login credentials...");
                    const userField = page.locator('input[name="LoginUserName"]:visible').first();
                    const passField = page.locator('input[name="LoginPassword"]:visible').first();
                    await userField.waitFor({ state: "visible", timeout: 20000 });
                    await passField.waitFor({ state: "visible", timeout: 20000 });
                    await userField.fill(username);
                    await passField.fill(password);

                    const submit = page.locator(`${LOGIN_SUBMIT}:visible`).first();
                    if ((await submit.count()) > 0) {
                        await submit.click();
                    } else {
                        await page.locator(LOGIN_SUBMIT_FALLBACK).first().click();
                    }
                } catch (err) {
                    if (!interactive) {
                        throw new Error(
                            "Could not complete the credential form automatically: " +
                                `${err instanceof Error ? err.message : String(err)}. ` +
                                "Re-run with --headed to see the page and finish sign-in by hand.",
                        );
                    }
                    console.log("ℹ️ Credential autofill skipped, proceeding interactively...");
                }
            } else if (!username || !password) {
                if (!interactive) {
                    throw new Error("Headless login needs credentials; none were found in the environment.");
                }
                console.log("ℹ️ No credentials in the environment — complete sign-in in the browser window.");
            }

            // Clear any 2FA gate that appears after the credentials are accepted.
            await this.completeTwoFactor(page, { secret: totp?.secret ?? null, interactive });

            console.log("⏳ Waiting for dashboard to load...");
            await page.waitForURL((url) => isAuthenticatedUrl(url.href.toLowerCase()), { timeout: 120000 });

            console.log("✅ Authenticated! Extracting session cookies and CSRF tokens...");

            // Navigate to domain control panel to ensure domain-specific tokens are loaded
            const domainPanelUrl = `https://ap.www.namecheap.com/domains/domaincontrolpanel/${domain}/domain`;
            await page.goto(domainPanelUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
            await page.waitForTimeout(2000);

            const cookies = await context.cookies();
            const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

            const csrfToken = await page.evaluate(() => {
                const meta = document.querySelector('meta[name="ncCompliance"], meta[name="_nccompliance"]');
                if (meta) return meta.getAttribute("content");
                for (const part of document.cookie.split(";")) {
                    const trimmed = part.trim().toLowerCase();
                    if (trimmed.startsWith("x-ncpl-csrf=") || trimmed.startsWith("_nccompliance=") || trimmed.startsWith("nc-csrf-token=")) {
                        return part.split("=").slice(1).join("=").trim();
                    }
                }
                return null;
            });

            const capturedStorageState = await context.storageState();
            await fs.mkdir(this.sessionDir, { recursive: true });
            await fs.writeFile(this.getAuthStatePath(domain), JSON.stringify(capturedStorageState, null, 2));

            const session: StealthSession = {
                cookies: cookieString,
                csrfToken: resolveCsrfToken(csrfToken, cookieString),
                storageState: capturedStorageState,
                savedAt: new Date().toISOString(),
            };

            await this.saveSession(domain, session);
            return session;
        } finally {
            await browser.close();
        }
    }

    /**
     * Waits for the post-credential outcome and clears a 2FA gate if one
     * appears. Resolves as soon as the session is authenticated, so accounts
     * without 2FA are unaffected.
     */
    private async completeTwoFactor(
        page: Page,
        options: { secret: string | null; interactive: boolean },
    ): Promise<TwoFactorMethod | null> {
        const { secret, interactive } = options;
        const deadline = Date.now() + 120_000;

        while (Date.now() < deadline) {
            const href = page.url().toLowerCase();

            if (isAuthenticatedUrl(href)) return null;
            if (isTotpUrl(href)) {
                return await this.clearTotpGate(page, secret, interactive);
            }
            if (isTwoFactorUrl(href)) {
                // e.g. the emailed-code or backup-code variant of the gate
                throw new Error(
                    `Namecheap is requesting a 2FA method this tool does not automate (${page.url()}). ` +
                        "Complete it manually, or re-enrol the authenticator app to use the TOTP gate.",
                );
            }

            await page.waitForTimeout(1000);
        }

        throw new Error("Timed out waiting for Namecheap to present either the dashboard or a 2FA gate.");
    }

    /**
     * Submits a TOTP code for the gate at /twofa/totp/, generating it from the
     * stored seed when available and falling back to a terminal prompt.
     */
    private async clearTotpGate(
        page: Page,
        secret: string | null,
        interactive: boolean,
    ): Promise<TwoFactorMethod> {
        console.log("🔒 Namecheap requires 2FA (TOTP authenticator code).");

        if (!secret) {
            if (!interactive) {
                throw new Error(
                    "Namecheap requires a TOTP code but no seed is configured. " +
                        "Run `namecheap-forwarder 2fa:setup -d <domain>` first, or drop --headless to enter the code by hand.",
                );
            }
            const field = await this.waitForOtpField(page);
            const code = await promptTerminal("   👉 Enter the code from your authenticator app: ");
            await this.submitOtp(page, field, code);
            return "manual";
        }

        for (let attempt = 1; attempt <= MAX_TOTP_ATTEMPTS; attempt++) {
            let totp = generateTotp(secret);

            // A code generated at the tail of its window can expire mid-request.
            if (totp.validForSeconds < MIN_TOTP_VALIDITY_SECONDS) {
                const waitMs = (totp.validForSeconds + 1) * 1000;
                console.log(`   ⏳ TOTP window nearly closed, waiting ${waitMs / 1000}s for the next one...`);
                await page.waitForTimeout(waitMs);
                totp = generateTotp(secret);
            }

            const field = await this.waitForOtpField(page);
            console.log(`   🔑 Submitting TOTP code (valid for ${totp.validForSeconds}s) [attempt ${attempt}/${MAX_TOTP_ATTEMPTS}]`);
            await this.submitOtp(page, field, totp.code);

            const passed = await this.waitForOtpVerdict(page);
            if (passed) {
                console.log("   ✅ TOTP accepted.");
                return "totp";
            }

            if (attempt < MAX_TOTP_ATTEMPTS) {
                // Wait out the rest of the rejected window so the retry is unambiguous.
                const remainingMs = secondsRemaining() + 1000;
                console.log(`   ⚠️ Code rejected; retrying against a fresh window in ${Math.ceil(remainingMs / 1000)}s.`);
                await page.waitForTimeout(remainingMs);
            }
        }

        throw new Error(
            "Namecheap rejected the TOTP code twice. Confirm the stored seed matches your authenticator app " +
                "(compare with `namecheap-forwarder 2fa:code`).",
        );
    }

    /** Locates the OTP input, preferring the form-scoped match. */
    private async findOtpField(page: Page): Promise<Locator | null> {
        const candidates = [OTP_INPUT_IN_FORM, `${OTP_FORM} ${OTP_INPUT}`, OTP_INPUT, 'input[type="tel"]:visible'];
        for (const selector of candidates) {
            const locator = page.locator(selector).first();
            if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
                return locator;
            }
        }
        return null;
    }

    private async waitForOtpField(page: Page): Promise<Locator> {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            const field = await this.findOtpField(page);
            if (field) return field;
            await page.waitForTimeout(500);
        }
        throw new Error("Found the 2FA page but could not locate the OTP code field.");
    }

    /** Fills the code and clicks the Submit button belonging to the same form. */
    private async submitOtp(page: Page, field: Locator, code: string): Promise<void> {
        await field.fill(code);

        const submit = page
            .locator(`${OTP_SUBMIT_IN_FORM}:visible, ${OTP_SUBMIT_NEAR_INPUT}:visible`)
            .first();
        if ((await submit.count()) > 0) {
            await submit.click();
            return;
        }

        throw new Error("Found the OTP field but not the form's Submit button.");
    }

    /**
     * Resolves true when the code was accepted.
     *
     * Namecheap's gate submits the code with JavaScript, and the rejection path
     * may either re-navigate to /twofa/ or simply re-render the form in place.
     * A URL check alone would therefore report a false success for an in-place
     * rejection, so acceptance is inferred from the gate disappearing and has
     * to be observed twice in a row to avoid a transient DOM gap.
     */
    private async waitForOtpVerdict(page: Page): Promise<boolean> {
        const deadline = Date.now() + OTP_VERDICT_TIMEOUT_MS;
        let consecutiveCleared = 0;

        while (Date.now() < deadline) {
            const formPresent = (await this.findOtpField(page)) !== null;
            consecutiveCleared = formPresent ? 0 : consecutiveCleared + 1;
            if (consecutiveCleared >= 2) return true;
            await page.waitForTimeout(500);
        }

        return false;
    }
}

export { DASHBOARD_URL };
