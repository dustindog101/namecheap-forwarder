import { collectDomains, parseDomainPage } from "./domains.js";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { BASE_URL } from "./client.js";
import { RequestQueue, formatDomain, normalizeAlias, normalizeEmail, parseCookieString, resolveCsrfToken, type RequestQueueOptions } from "./helpers.js";
import { isLoginUrl, isCloudflareBlock, parseForwardersResponse, parseMutationResponse } from "./parse.js";
import { launchChromium, loadPlaywright } from "./playwright.js";
import {
    SessionExpiredError,
    CloudflareBlockedError,
    NamecheapApiError,
    type MutationResult,
    type NamecheapClientLike,
    type NamecheapForward,
    type StealthSession,
} from "./types.js";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

export type StealthClientOptions = RequestQueueOptions & {
    /**
     * Remote browser to use instead of launching one. Accepts a Playwright server endpoint
     * (e.g. from `ncf serve`) or a CDP endpoint (Browserless, Chrome --remote-debugging-port).
     */
    wsEndpoint?: string;
    /** Custom browser factory, e.g. @sparticuz/chromium on Vercel/Lambda. Takes precedence over wsEndpoint. */
    launch?: () => Promise<Browser>;
    queue?: RequestQueue;
    /** Timeout for each dashboard fetch. Default 30 seconds. */
    timeoutMs?: number;
};

/**
 * Browser-backed client: runs the same API calls from inside a real Chromium page,
 * which gets past Cloudflare challenges that block plain fetch. Slower (browser startup),
 * so keep one instance alive for a batch of operations and call close() when done.
 */
export class StealthNamecheapClient implements NamecheapClientLike {
    private csrf: string | null;
    private readonly domain?: string;
    private readonly wsEndpoint?: string;
    private readonly launch?: () => Promise<Browser>;
    private readonly queue: RequestQueue;
    private readonly timeoutMs: number;
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private ready: Promise<Page> | null = null;

    constructor(
        private readonly session: StealthSession,
        domain?: string,
        options: StealthClientOptions | string = {}
    ) {
        // Backwards compatible: third argument used to be the ws endpoint string
        const opts = typeof options === "string" ? { wsEndpoint: options } : options;
        this.domain = domain === undefined ? undefined : formatDomain(domain);
        this.csrf = resolveCsrfToken(session.csrfToken, session.cookies);
        this.timeoutMs = opts.timeoutMs ?? 30_000;
        this.wsEndpoint = opts.wsEndpoint;
        this.launch = opts.launch;
        this.queue = opts.queue ?? new RequestQueue({ minIntervalMs: 250, ...opts });
    }

    private ensureReady(): Promise<Page> {
        this.ready ??= this.open().catch(async (err) => {
            await this.close();
            throw err;
        });
        return this.ready;
    }

    private async open(): Promise<Page> {
        if (this.launch) {
            this.browser = await this.launch();
        } else if (this.wsEndpoint) {
            const { chromium } = await loadPlaywright();
            try {
                this.browser = await chromium.connect(this.wsEndpoint, { timeout: 15_000 });
            } catch {
                this.browser = await chromium.connectOverCDP(this.wsEndpoint, { timeout: 15_000 });
            }
        } else {
            this.browser = await launchChromium({ headless: true });
        }

        const contextOptions: { userAgent: string; storageState?: Record<string, unknown> } = { userAgent: USER_AGENT };
        if (this.session.storageState) contextOptions.storageState = this.session.storageState;

        this.context = await this.browser.newContext(contextOptions as Parameters<Browser["newContext"]>[0]);
        if (!this.session.storageState && this.session.cookies) {
            await this.context.addCookies(parseCookieString(this.session.cookies));
        }

        const page = await this.context.newPage();
        const target = this.domain ? `${BASE_URL}/domains/domaincontrolpanel/${this.domain}/domain` : `${BASE_URL}/domains/list`;
        for (let attempt = 0; ; attempt++) {
            try {
                await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
                break;
            } catch (err) {
                if (attempt >= 2) throw err;
                await page.waitForTimeout(1500 * (attempt + 1));
            }
        }

        if (isLoginUrl(page.url())) throw new SessionExpiredError();
        if (isCloudflareBlock(await page.locator("body").innerText())) throw new CloudflareBlockedError();
        const token = await page.evaluate(() => {
            const element = document.querySelector('input[name="ncCompliance"], input[name="_nccompliance"], meta[name="ncCompliance"], meta[name="_nccompliance"]');
            return element?.getAttribute("value") ?? element?.getAttribute("content") ?? null;
        });
        if (token) this.csrf = token;
        this.page = page;
        return page;
    }

    async close() {
        await this.context?.close().catch(() => {});
        await this.browser?.close().catch(() => {});
        this.context = null;
        this.browser = null;
        this.page = null;
        this.ready = null;
    }

    private async apiRequest(path: string, body?: unknown) {
        const page = await this.ensureReady();
        const res = await page.evaluate(
            async ({ apiPath, payload, token, timeoutMs }) => {
                const headers: Record<string, string> = {
                    "Content-Type": "application/json;charset=UTF-8",
                    Accept: "application/json, text/plain, */*",
                };
                if (apiPath.startsWith("/api/v1/ncpl/")) {
                    const loginToken = document.cookie.match(/(?:^|;\s*)x-ncpl-csrf=([^;]+)/)?.[1] ?? document.getElementById("x-ncpl-csrfvalue")?.getAttribute("value");
                    if (loginToken) headers["x-ncpl-rcsrf"] = loginToken;
                }
                if (token) {
                    headers._nccompliance = token;
                    headers.ncCompliance = token;
                }
                const resp = await fetch(apiPath, {
                    method: payload ? "POST" : "GET",
                    headers,
                    body: payload ? JSON.stringify(payload) : undefined,
                    credentials: "include",
                    signal: AbortSignal.timeout(timeoutMs),
                });
                return { status: resp.status, url: resp.url, text: await resp.text() };
            },
            { apiPath: path, payload: body ?? null, token: this.csrf, timeoutMs: this.timeoutMs }
        );
        if (isLoginUrl(new URL(res.url).pathname)) throw new SessionExpiredError(undefined, res.status);
        return res;
    }

    private requireDomain(): string {
        if (!this.domain) throw new Error("Forwarding requires a domain. Pass it to StealthNamecheapClient(session, domain).");
        return this.domain;
    }

    async listDomains() {
        return collectDomains((page, size) => this.queue.run(async () => {
            const { status, text } = await this.apiRequest("/api/v1/ncpl/gatewaydomainlist/getdomainsonly", { gridPageRequestViewModel: { PageSize: size, Page: page } });
            if (isCloudflareBlock(text, status)) throw new CloudflareBlockedError(status);
            if (status === 401 || status === 403) throw new SessionExpiredError(undefined, status);
            if (status !== 200) throw new NamecheapApiError(`Domain discovery returned HTTP ${status}`, status);
            return parseDomainPage(text);
        }));
    }

    async listForwarders(): Promise<NamecheapForward[]> {
        return this.queue.run(async () => {
            const { status, text } = await this.apiRequest(
                `/Domains/DomainDetails/GetDomainDetailsTabOverView?domainName=${encodeURIComponent(this.requireDomain())}`
            );
            if (isCloudflareBlock(text, status)) throw new CloudflareBlockedError(status);
            if (status === 401 || status === 403) throw new SessionExpiredError(undefined, status);
            if (status < 200 || status >= 300) throw new NamecheapApiError(`Failed to fetch forwards: HTTP ${status}`, status);
            return parseForwardersResponse(text);
        });
    }

    async addForwarder(alias: string, forwardTo: string): Promise<MutationResult> {
        return this.queue.run(async () => {
            const { status, text } = await this.apiRequest("/Domains/AddForwarder", {
                domainName: this.requireDomain(),
                mailBox: normalizeAlias(alias),
                forwardTo: normalizeEmail(forwardTo),
            });
            return parseMutationResponse(text, status);
        });
    }

    async deleteForwarder(alias: string, forwardTo: string): Promise<MutationResult> {
        return this.deleteForwarders([{ alias, forwardTo }]);
    }

    async deleteForwarders(forwards: { alias: string; forwardTo: string }[]): Promise<MutationResult> {
        return this.queue.run(async () => {
            const { status, text } = await this.apiRequest("/Domains/DeleteForwarder", {
                model: {
                    DomainName: this.requireDomain(),
                    Forwarders: forwards.map((f) => ({ MailboxId: -1, MailboxName: normalizeAlias(f.alias), ForwardTo: normalizeEmail(f.forwardTo) })),
                },
            });
            return parseMutationResponse(text, status);
        });
    }

    async isSessionValid(): Promise<boolean> {
        try {
            await this.listForwarders();
            return true;
        } catch (err) {
            if (err instanceof SessionExpiredError) return false;
            throw err;
        }
    }

    /**
     * Current cookies + storage state from the live browser. Save these after a successful call
     * to keep a long-running session fresh (Namecheap rotates cookies as you use it).
     */
    async exportSession(): Promise<StealthSession | null> {
        if (!this.context) return null;
        const cookies = (await this.context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
        const storageState = (await this.context.storageState()) as unknown as Record<string, unknown>;
        return {
            cookies,
            csrfToken: this.csrf ?? resolveCsrfToken(null, cookies),
            storageState,
            savedAt: new Date().toISOString(),
        };
    }
}
