import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { StealthSession, NamecheapForward, NamecheapClientLike } from "./types.js";
import { resolveCsrfToken, parseCookieString, parseApiPayload } from "./helpers.js";
import { parseForwardersResponse } from "./parse.js";

const BASE_URL = "https://ap.www.namecheap.com";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

export class StealthNamecheapClient implements NamecheapClientLike {
    private csrf: string | null;
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;

    constructor(
        private session: StealthSession,
        private domain: string,
        private wsEndpoint?: string
    ) {
        this.csrf = resolveCsrfToken(session.csrfToken, session.cookies);
    }

    private async ensureReady() {
        if (this.page) return;

        if (this.wsEndpoint) {
            this.browser = await chromium.connectOverCDP(this.wsEndpoint);
        } else {
            this.browser = await chromium.launch({ headless: true });
        }

        const contextOptions: { userAgent: string; storageState?: Record<string, unknown> } = { userAgent: USER_AGENT };
        if (this.session.storageState) contextOptions.storageState = this.session.storageState;

        this.context = await this.browser.newContext(contextOptions as Parameters<Browser["newContext"]>[0]);

        if (!this.session.storageState && this.session.cookies) {
            await this.context.addCookies(parseCookieString(this.session.cookies));
        }

        this.page = await this.context.newPage();
        
        const target = `${BASE_URL}/domains/domaincontrolpanel/${this.domain}/domain`;
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await this.page.goto(target, { waitUntil: "domcontentloaded", timeout: 90000 });
                lastError = undefined;
                break;
            } catch (err) {
                lastError = err;
                await this.page.waitForTimeout(1500 * (attempt + 1));
            }
        }
        if (lastError) throw lastError;

        const url = this.page.url().toLowerCase();
        if (url.includes("login") || url.includes("twofa") || url.includes("verification")) {
            await this.close();
            throw new Error("SESSION_EXPIRED");
        }
    }

    async close() {
        await this.context?.close().catch(() => {});
        await this.browser?.close().catch(() => {});
        this.context = null;
        this.browser = null;
        this.page = null;
    }

    private async apiRequest(path: string, body?: unknown) {
        await this.ensureReady();
        const page = this.page!;
        return page.evaluate(
            async ({ apiPath, payload, token }) => {
                const headers: Record<string, string> = {
                    "Content-Type": "application/json;charset=UTF-8",
                    Accept: "application/json, text/plain, */*",
                };
                if (token) {
                    headers._nccompliance = token;
                    headers.ncCompliance = token;
                }
                const resp = await fetch(apiPath, {
                    method: payload ? "POST" : "GET",
                    headers,
                    body: payload ? JSON.stringify(payload) : undefined,
                    credentials: "include",
                });
                return { status: resp.status, text: await resp.text() };
            },
            { apiPath: path, payload: body ?? null, token: this.csrf }
        );
    }

    async listForwarders(): Promise<NamecheapForward[] | null> {
        try {
            const { status, text } = await this.apiRequest(`/Domains/DomainDetails/GetDomainDetailsTabOverView?domainName=${this.domain}`);
            if (status === 401 || status === 403) return null;
            try {
                return parseForwardersResponse(text);
            } catch (err) {
                if (err instanceof Error && err.message === "CLOUDFLARE_BLOCKED") {
                    return parseForwardersResponse(await this.page!.content());
                }
                throw err;
            }
        } catch (err) {
            if (err instanceof Error && err.message === "SESSION_EXPIRED") return null;
            throw err;
        }
    }

    async addForwarder(alias: string, forwardTo: string) {
        const { status, text } = await this.apiRequest("/Domains/AddForwarder", {
            domainName: this.domain,
            mailBox: alias,
            forwardTo,
        });
        if (status === 401 || status === 403) return null;
        // A 200 can still carry {"Error":true,...}; surface that instead of
        // reporting a write as successful.
        return parseApiPayload(text);
    }

    async deleteForwarder(alias: string, forwardTo: string) {
        const { status, text } = await this.apiRequest("/Domains/DeleteForwarder", {
            model: {
                DomainName: this.domain,
                Forwarders: [{ MailboxId: -1, MailboxName: alias, ForwardTo: forwardTo }],
            },
        });
        if (status === 401 || status === 403) return null;
        return parseApiPayload(text);
    }
}
