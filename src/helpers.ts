import { domainToASCII } from "node:url";
import { CloudflareBlockedError, NamecheapError } from "./types.js";

/**
 * Resolves the CSRF token from either an explicit token or from a cookies string.
 * Supports Namecheap header & cookie keys: x-ncpl-csrf, _nccompliance, ncCompliance, nc-csrf-token.
 */
export function resolveCsrfToken(csrfToken: string | null | undefined, cookies: string): string | null {
    if (csrfToken && csrfToken.trim().length > 0) return csrfToken.trim();
    if (!cookies) return null;

    const match =
        cookies.match(/(?:^|;\s*)x-ncpl-csrf=([^;]+)/i) ||
        cookies.match(/(?:^|;\s*)_nccompliance=([^;]+)/i) ||
        cookies.match(/(?:^|;\s*)nccompliance=([^;]+)/i) ||
        cookies.match(/(?:^|;\s*)nc-csrf-token=([^;]+)/i);

    return match ? match[1].trim() : null;
}

/**
 * Calculates session age in hours from saved ISO timestamp.
 */
export function getSessionAgeHours(savedAt?: string): number {
    if (!savedAt) return Infinity;
    return (Date.now() - new Date(savedAt).getTime()) / (1000 * 60 * 60);
}

/**
 * Formats a domain name (lowercase, trim).
 */
export function formatDomain(domain: string): string {
    if (/[\s/\\:@?#]/.test(domain.trim())) throw new Error("Invalid domain. Use a domain name such as example.com, without a URL or path.");
    const normalized = domainToASCII(domain.trim().toLowerCase().replace(/\.$/, ""));
    if (!normalized || normalized.length > 253 || !normalized.includes(".") || normalized.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new Error("Invalid domain. Use a domain name such as example.com, without a URL or path.");
    }
    return normalized;
}

const ALIAS_PATTERN = /^(\*|[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?)$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercases and trims an alias; throws on characters Namecheap will not accept. */
export function normalizeAlias(alias: string): string {
    const a = alias.trim().toLowerCase();
    if (!ALIAS_PATTERN.test(a)) {
        throw new Error(`Invalid alias "${alias}". Use letters, digits, ".", "_", "-", "+" or "*" for catch-all.`);
    }
    return a;
}

/** Trims a destination address; throws when it is not an email address. */
export function normalizeEmail(email: string): string {
    const e = email.trim();
    if (!EMAIL_PATTERN.test(e)) throw new Error(`Invalid destination email "${email}".`);
    return e;
}

/** Splits "alias@domain" into parts. Returns null for a bare alias. */
export function splitAddress(address: string): { alias: string; domain: string } | null {
    const at = address.lastIndexOf("@");
    if (at <= 0) return null;
    return { alias: address.slice(0, at), domain: formatDomain(address.slice(at + 1)) };
}

/** Case-insensitive key for comparing a forward (alias + destination). */
export function forwardKey(alias: string, forwardTo: string): string {
    return `${alias.toLowerCase()}\u0000${forwardTo.toLowerCase()}`;
}

/**
 * Parses a standard cookie string into an array of cookie objects compatible with Playwright.
 */
export function parseCookieString(cookieString: string) {
    const domains = [".namecheap.com", "ap.www.namecheap.com", "www.namecheap.com"];
    const cookies: { name: string; value: string; domain: string; path: string }[] = [];

    for (const part of cookieString.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (!name) continue;
        for (const domain of domains) {
            cookies.push({ name, value, domain, path: "/" });
        }
    }

    return cookies;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type RequestQueueOptions = {
    /** Minimum gap between the start of consecutive requests. */
    minIntervalMs?: number;
    /** Retries for Cloudflare/429 and network errors (never for auth or API rejections). */
    retries?: number;
    /** Base backoff; doubles each retry. */
    retryDelayMs?: number;
};

/**
 * Runs tasks one at a time with a minimum spacing and retry/backoff.
 * One queue per Namecheap account keeps a single process from hammering the dashboard API.
 */
export class RequestQueue {
    private tail: Promise<unknown> = Promise.resolve();
    private lastStart = 0;
    private readonly minIntervalMs: number;
    private readonly retries: number;
    private readonly retryDelayMs: number;

    constructor(options: RequestQueueOptions = {}) {
        this.minIntervalMs = options.minIntervalMs ?? 0;
        this.retries = options.retries ?? 2;
        this.retryDelayMs = options.retryDelayMs ?? 1000;
    }

    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.tail.then(() => this.execute(task));
        this.tail = result.catch(() => {});
        return result;
    }

    private async execute<T>(task: () => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            const wait = this.lastStart + this.minIntervalMs - Date.now();
            if (wait > 0) await sleep(wait);
            this.lastStart = Date.now();
            try {
                return await task();
            } catch (err) {
                if (attempt >= this.retries || !isRetryable(err)) throw err;
                await sleep(this.retryDelayMs * 2 ** attempt);
            }
        }
    }
}

function isRetryable(err: unknown): boolean {
    if (err instanceof CloudflareBlockedError) return true;
    if (err instanceof NamecheapError) return err.code === "API_ERROR" && (err.status ?? 0) >= 500;
    // fetch() network failures surface as TypeError
    return err instanceof TypeError;
}

/** Dashboard mutation token is a hidden input, distinct from the login CSRF cookie. */
export function extractDashboardCsrf(html: string): string | null {
    for (const tag of html.match(/<(?:input|meta)\b[^>]*>/gi) ?? []) {
        const attributes = new Map<string, string>();
        for (const match of tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)) attributes.set(match[1].toLowerCase(), match[3]);
        if (!/^(?:_?nccompliance)$/i.test(attributes.get("name") ?? "")) continue;
        const token = attributes.get("value") ?? attributes.get("content");
        if (token && /^[\w.-]+$/.test(token)) return token;
    }
    return null;
}
