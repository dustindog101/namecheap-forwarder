import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { StealthSession } from "./types.js";
import { parseCookieString, resolveCsrfToken, getSessionAgeHours } from "./helpers.js";

const LOGIN_URL = "https://www.namecheap.com/myaccount/login/";
const DASHBOARD_URL = "https://ap.www.namecheap.com/domains/";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

function promptTerminal(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

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

    async interactiveLogin(
        domain: string,
        options: { username?: string; password?: string; headless?: boolean } = {}
    ): Promise<StealthSession> {
        const { username, password, headless = false } = options;

        const browser = await chromium.launch({
            headless: headless && Boolean(username && password),
        });

        const authStatePath = this.getAuthStatePath(domain);
        let storageState: Record<string, unknown> | undefined;
        try {
            const raw = await fs.readFile(authStatePath, "utf-8");
            storageState = JSON.parse(raw);
        } catch {}

        const contextOptions: any = {
            userAgent: USER_AGENT,
        };
        if (storageState) {
            contextOptions.storageState = storageState;
        }

        const context = await browser.newContext(contextOptions);

        const page = await context.newPage();

        console.log(`🌐 Opening Namecheap login page for ${domain}...`);
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

        // If credentials are provided and we are on login page, fill them
        if (username && password && page.url().toLowerCase().includes("login")) {
            try {
                console.log("🔑 Entering login credentials...");
                const userField = page.locator('input[name="LoginUserName"]:visible').first();
                const passField = page.locator('input[name="LoginPassword"]:visible').first();
                await userField.waitFor({ state: "visible", timeout: 8000 });
                await userField.fill(username);
                await passField.fill(password);
                const submitBtn = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
                await submitBtn.click();
                await page.waitForTimeout(3000);
            } catch (err) {
                console.log("ℹ️ Credential autofill skipped, proceeding interactively...");
            }
        }

        // Check if 2FA / Device verification is requested
        let currentUrl = page.url().toLowerCase();
        if (currentUrl.includes("twofa") || currentUrl.includes("verification") || currentUrl.includes("device")) {
            console.log("\n🔒 Namecheap 2FA / Device Verification required!");
            const code = await promptTerminal("   👉 Enter the verification code sent to your email/app: ");
            try {
                const codeInput = page.locator('input[type="text"]:visible').first();
                await codeInput.waitFor({ state: "visible", timeout: 10000 });
                await codeInput.fill(code);
                const submitBtn = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
                await submitBtn.click();
                await page.waitForTimeout(4000);
            } catch (err) {
                console.log("⚠️ Could not auto-submit 2FA. Please complete in browser window if open.");
            }
        }

        // Wait for dashboard or domain panel navigation
        console.log("⏳ Waiting for dashboard to load...");
        await page.waitForURL((url) => {
            const href = url.href.toLowerCase();
            return (
                href.includes("ap.www.namecheap.com") &&
                !href.includes("login") &&
                !href.includes("twofa") &&
                !href.includes("verification")
            );
        }, { timeout: 300000 });

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
        await fs.writeFile(authStatePath, JSON.stringify(capturedStorageState, null, 2));

        await browser.close();

        const session: StealthSession = {
            cookies: cookieString,
            csrfToken: resolveCsrfToken(csrfToken, cookieString),
            storageState: capturedStorageState,
            savedAt: new Date().toISOString(),
        };

        await this.saveSession(domain, session);
        return session;
    }
}
