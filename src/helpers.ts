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
    return domain.trim().toLowerCase();
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
