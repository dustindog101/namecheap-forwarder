/**
 * Resolves the CSRF token from either an explicit token or from a cookies string.
 *
 * Namecheap issues TWO different tokens and conflating them breaks writes:
 *   • `_NcCompliance` — a GUID, the anti-forgery token the write endpoints
 *     (`/Domains/AddForwarder`, `/Domains/DeleteForwarder`) validate against.
 *   • `x-ncpl-csrf` — a 32-char hex token used by read paths.
 *
 * Sending `x-ncpl-csrf` as the `ncCompliance` header makes every write return
 * HTTP 200 with `{"Error":true,"Msg":"A required anti-forgery token was not
 * supplied or was invalid"}`, so `_NcCompliance` is checked first.
 */
export function resolveCsrfToken(csrfToken: string | null | undefined, cookies: string): string | null {
    if (csrfToken && csrfToken.trim().length > 0) return csrfToken.trim();
    if (!cookies) return null;

    const match =
        cookies.match(/(?:^|;\s*)_nccompliance=([^;]+)/i) ||
        cookies.match(/(?:^|;\s*)x-ncpl-csrf=([^;]+)/i) ||
        cookies.match(/(?:^|;\s*)ncCompliance=([^;]+)/i) ||
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
    return domain.trim().toLowerCase();
}

/**
 * Parses a Namecheap JSON response and throws when the API reports failure.
 *
 * Namecheap signals application-level errors with HTTP 200 and
 * `{"Result":null,"Error":true,"Msg":"..."}`. Treating any 200 as success is
 * how a rejected write ends up reported as "Successfully added forwarder".
 */
export function parseApiPayload(text: string): unknown {
    let payload: unknown;
    try {
        payload = JSON.parse(text);
    } catch {
        return { success: true };
    }

    if (payload && typeof payload === "object") {
        const p = payload as Record<string, unknown>;
        if (p.Error === true || p.error === true) {
            const msg = typeof p.Msg === "string" && p.Msg ? p.Msg : "request rejected";
            const errors = p.Errors;
            const detail =
                Array.isArray(errors) && errors.length > 0 ? ` ${JSON.stringify(errors)}` : "";
            throw new Error(`Namecheap API error: ${msg}${detail}`);
        }
    }

    return payload;
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
