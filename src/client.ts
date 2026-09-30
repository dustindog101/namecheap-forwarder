import { collectDomains, parseDomainPage } from "./domains.js";
import { createSessionJar, exportJarSession } from "./cookie-jar.js";
import type { CookieJar } from "tough-cookie";
import { RequestQueue, formatDomain, resolveCsrfToken, extractDashboardCsrf, normalizeAlias, normalizeEmail, type RequestQueueOptions } from "./helpers.js";
import { isCloudflareBlock, isLoginUrl, parseForwardersResponse, parseMutationResponse } from "./parse.js";
import {
    CloudflareBlockedError,
    NamecheapApiError,
    SessionExpiredError,
    type MutationResult,
    type NamecheapClientLike,
    type NamecheapForward,
    type NamecheapSession,
} from "./types.js";

export const BASE_URL = "https://ap.www.namecheap.com";

const BROWSER_HEADERS: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
};

export type NamecheapClientOptions = RequestQueueOptions & {
    /**
     * Share one queue between clients for different domains on the same Namecheap account,
     * so their requests are serialized together.
     */
    queue?: RequestQueue;
    /** Per-request timeout. Default 30s. */
    timeoutMs?: number;
    /** Override the dashboard origin (for tests / proxies). Also read from NAMECHEAP_BASE_URL. */
    baseUrl?: string;
};

/**
 * Direct HTTP client (plain fetch, no browser). Fast, works in serverless.
 * All requests from one instance run through a serial queue with retry on Cloudflare/429/5xx.
 */
export class NamecheapClient implements NamecheapClientLike {
    private csrf: string | null;
    private readonly domain?: string;
    private readonly queue: RequestQueue;
    private readonly timeoutMs: number;
    private readonly baseUrl: string;
    private readonly cookies: CookieJar;

    constructor(
        private readonly session: NamecheapSession,
        domain?: string,
        options: NamecheapClientOptions = {}
    ) {
        this.domain = domain === undefined ? undefined : formatDomain(domain);
        this.csrf = resolveCsrfToken(session.csrfToken, session.cookies);
        this.queue = options.queue ?? new RequestQueue({ minIntervalMs: 250, ...options });
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.baseUrl = options.baseUrl ?? process.env.NAMECHEAP_BASE_URL ?? BASE_URL;
        this.cookies = createSessionJar(session, this.baseUrl);
    }

    private requireDomain(): string {
        if (!this.domain) throw new Error("Forwarding requires a domain. Pass it to NamecheapClient(session, domain).");
        return this.domain;
    }

    async listDomains() {
        return collectDomains((page, size) => this.queue.run(async () => {
            const token = this.cookies.getCookiesSync(this.baseUrl).find(cookie => cookie.key === "x-ncpl-csrf")?.value;
            const headers: Record<string, string> = { ...this.baseHeaders(), "Content-Type": "application/json" };
            if (token) headers["x-ncpl-rcsrf"] = token;
            const { status, text } = await this.send("/api/v1/ncpl/gatewaydomainlist/getdomainsonly", { method: "POST", headers, body: JSON.stringify({ gridPageRequestViewModel: { PageSize: size, Page: page } }) });
            if (isCloudflareBlock(text, status)) throw new CloudflareBlockedError(status);
            if (status === 401 || status === 403) throw new SessionExpiredError(undefined, status);
            if (status !== 200) throw new NamecheapApiError(`Domain discovery returned HTTP ${status}`, status);
            return parseDomainPage(text);
        }));
    }

    private baseHeaders(): Record<string, string> {
        return {
            ...BROWSER_HEADERS,
            Cookie: this.cookies.getCookieStringSync(this.baseUrl),
            Origin: this.baseUrl,
            Referer: this.domain ? `${this.baseUrl}/domains/domaincontrolpanel/${this.domain}/domain` : `${this.baseUrl}/domains/list`,
        };
    }

    private async send(path: string, init: RequestInit): Promise<{ status: number; text: string }> {
        const resp = await fetch(`${this.baseUrl}${path}`, {
            ...init,
            headers: { ...init.headers as Record<string, string>, Cookie: this.cookies.getCookieStringSync(`${this.baseUrl}${path}`) },
            // An expired session answers with a 302 to the login page; following it would
            // hand us a 200 HTML page that looks like success.
            redirect: "manual",
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        for (const cookie of resp.headers.getSetCookie()) this.cookies.setCookieSync(cookie, `${this.baseUrl}${path}`, { ignoreError: true });
        if (resp.status >= 300 && resp.status < 400) {
            const location = resp.headers.get("location");
            if (isLoginUrl(location)) throw new SessionExpiredError(undefined, resp.status);
            throw new NamecheapApiError(`Unexpected redirect to ${location ?? "unknown"}`, resp.status);
        }
        return { status: resp.status, text: await resp.text() };
    }

    private async refreshCsrf(): Promise<void> {
        const { status, text } = await this.send(`/domains/domaincontrolpanel/${encodeURIComponent(this.requireDomain())}/domain`, { headers: this.baseHeaders() });
        if (isCloudflareBlock(text, status)) throw new CloudflareBlockedError(status);
        if (status < 200 || status >= 300) throw new NamecheapApiError("Could not refresh dashboard token", status);
        const token = extractDashboardCsrf(text);
        if (!token) throw new NamecheapApiError("Dashboard mutation token is missing. Run ncf login --browser or use --stealth.");
        this.csrf = token;
    }

    /** Validates the mutation result; one token refresh only after an explicit CSRF rejection. */
    async request(path: string, body: unknown): Promise<MutationResult> {
        return this.queue.run(async () => {
            const send = async () => {
                const headers: Record<string, string> = { ...this.baseHeaders(), "Content-Type": "application/json;charset=UTF-8" };
                if (this.csrf) { headers._nccompliance = this.csrf; headers.ncCompliance = this.csrf; }
                const { status, text } = await this.send(path, { method: "POST", headers, body: JSON.stringify(body) });
                return parseMutationResponse(text, status);
            };
            try { return await send(); }
            catch (error) {
                if (!(error instanceof NamecheapApiError) || !/anti-forgery|antiforgery|csrf token/i.test(error.message)) throw error;
                await this.refreshCsrf();
                return send();
            }
        });
    }

    async addForwarder(alias: string, forwardTo: string): Promise<MutationResult> {
        return this.request("/Domains/AddForwarder", {
            domainName: this.requireDomain(),
            mailBox: normalizeAlias(alias),
            forwardTo: normalizeEmail(forwardTo),
        });
    }

    async deleteForwarder(alias: string, forwardTo: string): Promise<MutationResult> {
        return this.deleteForwarders([{ alias, forwardTo }]);
    }

    /** Deletes several forwards in a single request (the endpoint accepts a list). */
    async deleteForwarders(forwards: { alias: string; forwardTo: string }[]): Promise<MutationResult> {
        return this.request("/Domains/DeleteForwarder", {
            model: {
                DomainName: this.requireDomain(),
                Forwarders: forwards.map((f) => ({ MailboxId: -1, MailboxName: normalizeAlias(f.alias), ForwardTo: normalizeEmail(f.forwardTo) })),
            },
        });
    }

    async listForwarders(): Promise<NamecheapForward[]> {
        return this.queue.run(async () => {
            const { status, text } = await this.send(
                `/Domains/DomainDetails/GetDomainDetailsTabOverView?domainName=${encodeURIComponent(this.requireDomain())}`,
                { headers: this.baseHeaders() }
            );
            if (isCloudflareBlock(text, status)) throw new CloudflareBlockedError(status);
            if (status === 401 || status === 403) throw new SessionExpiredError(undefined, status);
            if (status < 200 || status >= 300) throw new NamecheapApiError(`Failed to fetch forwards: HTTP ${status}`, status);
            return parseForwardersResponse(text);
        });
    }

    exportSession() { return exportJarSession(this.cookies, this.baseUrl, this.csrf, this.session); }

    /** True if Namecheap accepts the session. Cloudflare blocks and API errors are thrown, not hidden. */
    async isSessionValid(): Promise<boolean> {
        try {
            await this.listForwarders();
            return true;
        } catch (err) {
            if (err instanceof SessionExpiredError) return false;
            throw err;
        }
    }
}
