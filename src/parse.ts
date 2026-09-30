import { CloudflareBlockedError, NamecheapApiError, SessionExpiredError, type NamecheapForward } from "./types.js";

type RawForwarder = {
    MailBox?: string;
    MailboxName?: string;
    alias?: string;
    ForwardTo?: string;
    forwardTo?: string;
    MailBoxId?: number;
    MailboxId?: number;
    mailboxId?: number;
};

type ForwarderContainer = {
    RedirectEmailDetails?: RawForwarder[] | null;
    Forwarders?: RawForwarder[] | null;
    DomainDetails?: ForwarderContainer;
};

/**
 * Checks if the response text is a Cloudflare block or challenge.
 */
export function isCloudflareBlock(text: string, status?: number): boolean {
    if (status === 429) return true;
    if (status === 403 && (text.includes("cloudflare") || text.includes("cf-challenge"))) return true;
    return (
        text.includes("Just a moment...") ||
        text.includes("cf-challenge") ||
        text.includes("challenges.cloudflare.com") ||
        text.includes("enable JavaScript and cookies")
    );
}

/**
 * Checks if response indicates a redirect to login / verification.
 */
export function isLoginRedirect(text: string): boolean {
    if (isCloudflareBlock(text)) return false;
    const lower = text.toLowerCase();
    return (
        lower.includes("myaccount/login") ||
        lower.includes("loginusername") ||
        lower.includes("automated browser detected") ||
        lower.includes("device verification")
    );
}

/** True when a redirect Location / final URL points at Namecheap's login or 2FA flow. */
export function isLoginUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    const lower = url.toLowerCase();
    return lower.includes("login") || lower.includes("twofa") || lower.includes("verification");
}

/**
 * Fallback parser to extract forwards from HTML data attributes.
 */
export function parseForwardersFromHtml(html: string): NamecheapForward[] {
    const forwards: NamecheapForward[] = [];
    const pattern = /data-mailbox-name="([^"]+)"[^>]*data-forward-to="([^"]+)"/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(html)) !== null) {
        forwards.push({ alias: match[1], forwardTo: match[2] });
    }

    if (forwards.length > 0) return forwards;

    const altPattern = /data-forward-to="([^"]+)"[^>]*data-mailbox-name="([^"]+)"/gi;
    while ((match = altPattern.exec(html)) !== null) {
        forwards.push({ alias: match[2], forwardTo: match[1] });
    }

    return forwards;
}

function mapForwarders(list: RawForwarder[]): NamecheapForward[] {
    return list.map(f => {
        if (!f || typeof f !== "object") throw new NamecheapApiError("Unrecognized forwarder entry");
        const alias = f.MailboxName ?? f.MailBox ?? f.alias;
        const forwardTo = f.ForwardTo ?? f.forwardTo;
        if (typeof alias !== "string" || !alias || typeof forwardTo !== "string" || !forwardTo) throw new NamecheapApiError("Unrecognized forwarder entry");
        return { alias, forwardTo, mailboxId: f.MailboxId ?? f.MailBoxId ?? f.mailboxId };
    });
}

/** Finds a forwarder list in any of the known response shapes; undefined when absent. */
function findForwarderList(container: ForwarderContainer): RawForwarder[] | null | undefined {
    if ("RedirectEmailDetails" in container) return container.RedirectEmailDetails;
    if ("Forwarders" in container) return container.Forwarders;
    if (container.DomainDetails && typeof container.DomainDetails === "object") {
        return findForwarderList(container.DomainDetails);
    }
    return undefined;
}

/**
 * Parses the raw HTML/JSON response from Namecheap's GetDomainDetailsTabOverView endpoint.
 *
 * Throws SessionExpiredError for login pages and NamecheapApiError for responses it cannot
 * understand, so an expired session is never mistaken for "domain has no forwards".
 */
export function parseForwardersResponse(text: string): NamecheapForward[] {
    if (isCloudflareBlock(text)) {
        throw new CloudflareBlockedError();
    }
    if (isLoginRedirect(text)) {
        throw new SessionExpiredError();
    }

    // 1. Direct JSON — Result is either an object or a JSON-encoded string
    let data: { Result?: ForwarderContainer | string; Success?: boolean; Msg?: string } | undefined;
    try {
        data = JSON.parse(text);
    } catch {
        // Not JSON
    }

    if (data && typeof data === "object") {
        if (data.Success === false) throw new NamecheapApiError(data.Msg || "Namecheap rejected the list request", undefined, data);
        let result = data.Result;
        if (typeof result === "string") {
            try {
                result = JSON.parse(result) as ForwarderContainer;
            } catch {
                throw new NamecheapApiError("Unrecognized forwarders response (Result is not JSON)", undefined, data);
            }
        }
        if (result && typeof result === "object") {
            const list = findForwarderList(result);
            if (Array.isArray(list)) return mapForwarders(list);
            if (list === null) return [];
            throw new NamecheapApiError("Unrecognized forwarders response (missing forwarder list)", undefined, data);
        }
        throw new NamecheapApiError(
            `Unrecognized forwarders response${data.Msg ? `: ${data.Msg}` : ""}`,
            undefined,
            data
        );
    }

    // 2. Server-rendered page with window.nc_state = {...}
    const stateMatch = text.match(/window\.nc_state\s*=\s*({[\s\S]*?});/);
    if (stateMatch) {
        try {
            const state = JSON.parse(stateMatch[1]) as ForwarderContainer;
            const list = findForwarderList(state);
            if (Array.isArray(list)) return mapForwarders(list);
        } catch {}
    }

    // 3. HTML data attributes
    const fromHtml = parseForwardersFromHtml(text);
    if (fromHtml.length > 0) return fromHtml;

    throw new NamecheapApiError("Unrecognized forwarders response (Namecheap may have changed their dashboard)");
}

/**
 * Interprets a response from AddForwarder / DeleteForwarder.
 * Namecheap answers HTTP 200 even for rejected changes, so the body must be inspected.
 */
export function parseMutationResponse(text: string, status: number): { alreadyExisted: boolean; raw: unknown } {
    if (isCloudflareBlock(text, status)) throw new CloudflareBlockedError(status);
    if (status === 401 || status === 403) throw new SessionExpiredError(undefined, status);
    if (status < 200 || status >= 300) {
        throw new NamecheapApiError(`Namecheap API returned HTTP ${status}`, status);
    }

    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        if (isLoginRedirect(text)) throw new SessionExpiredError(undefined, status);
        throw new NamecheapApiError(`Unexpected non-JSON response from Namecheap (HTTP ${status})`, status);
    }

    if (raw === true) return { alreadyExisted: false, raw };
    if (!raw || typeof raw !== "object") {
        throw new NamecheapApiError("Unexpected response from Namecheap", status, raw);
    }

    const r = raw as Record<string, unknown>;
    const message = extractMessage(r);
    if (/already exist/i.test(message)) return { alreadyExisted: true, raw };
    if (r.Result === true || r.Success === true || r.success === true) return { alreadyExisted: false, raw };

    throw new NamecheapApiError(message ? `Namecheap rejected the request: ${message}` : "Namecheap rejected the request", status, raw);
}

function extractMessage(r: Record<string, unknown>): string {
    for (const key of ["Msg", "Message", "message", "Error", "error"]) {
        if (typeof r[key] === "string" && r[key]) return r[key] as string;
    }
    const errors = r.Errors ?? r.errors;
    if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        if (typeof first === "string") return first;
        if (first && typeof first === "object") {
            const m = (first as Record<string, unknown>).Message ?? (first as Record<string, unknown>).message;
            if (typeof m === "string") return m;
        }
    }
    return "";
}
