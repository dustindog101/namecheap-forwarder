import { resolveCsrfToken, parseApiPayload } from "./helpers.js";
import { parseForwardersResponse, isCloudflareBlock } from "./parse.js";
import type { NamecheapSession, NamecheapForward, NamecheapClientLike } from "./types.js";

const BASE_URL = "https://ap.www.namecheap.com";

const BROWSER_HEADERS: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
};

export class NamecheapClient implements NamecheapClientLike {
    private csrf: string | null;

    constructor(
        private session: NamecheapSession,
        private domain: string
    ) {
        this.csrf = resolveCsrfToken(session.csrfToken, session.cookies);
    }

    private get headers(): Record<string, string> {
        const h: Record<string, string> = {
            ...BROWSER_HEADERS,
            "Content-Type": "application/json;charset=UTF-8",
            Cookie: this.session.cookies,
            Origin: BASE_URL,
            Referer: `${BASE_URL}/domains/domaincontrolpanel/${this.domain}/domain`,
        };
        if (this.csrf) {
            h._nccompliance = this.csrf;
            h.ncCompliance = this.csrf;
        }
        return h;
    }

    async request(path: string, body: unknown): Promise<unknown | null> {
        const resp = await fetch(`${BASE_URL}${path}`, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(body),
        });

        const text = await resp.text();
        if (isCloudflareBlock(text, resp.status)) {
            throw new Error("CLOUDFLARE_BLOCKED");
        }

        if (resp.status === 401 || resp.status === 403) return null;

        if (!resp.ok) {
            throw new Error(`Namecheap API ${resp.status}: ${text.substring(0, 200)}`);
        }

        return parseApiPayload(text);
    }

    async addForwarder(alias: string, forwardTo: string) {
        return this.request("/Domains/AddForwarder", {
            domainName: this.domain,
            mailBox: alias,
            forwardTo,
        });
    }

    async deleteForwarder(alias: string, forwardTo: string) {
        return this.request("/Domains/DeleteForwarder", {
            model: {
                DomainName: this.domain,
                Forwarders: [{ MailboxId: -1, MailboxName: alias, ForwardTo: forwardTo }],
            },
        });
    }

    async listForwarders(): Promise<NamecheapForward[] | null> {
        const url = `${BASE_URL}/Domains/DomainDetails/GetDomainDetailsTabOverView?domainName=${this.domain}`;
        const resp = await fetch(url, {
            headers: {
                ...BROWSER_HEADERS,
                Cookie: this.session.cookies,
                Origin: BASE_URL,
                Referer: `${BASE_URL}/domains/domaincontrolpanel/${this.domain}/domain`,
            },
        });

        const text = await resp.text();

        if (isCloudflareBlock(text, resp.status)) {
            throw new Error("CLOUDFLARE_BLOCKED");
        }

        if (!resp.ok) {
            if (resp.status === 401 || resp.status === 403) return null;
            throw new Error(`Failed to fetch forwards: ${resp.status}`);
        }

        return parseForwardersResponse(text);
    }

    async isSessionValid(): Promise<boolean> {
        try {
            const result = await this.listForwarders();
            return result !== null;
        } catch (err) {
            if (err instanceof Error && err.message === "CLOUDFLARE_BLOCKED") {
                return false;
            }
            throw err;
        }
    }
}
