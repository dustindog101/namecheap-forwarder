import { Cookie, CookieJar } from "tough-cookie";
import type { NamecheapSession, StealthSession } from "./types.js";

/** Keep dashboard cookies scoped to their real host/path; ignore third-party browser cookies. */
export function createSessionJar(session: NamecheapSession, origin: string): CookieJar {
    const jar = new CookieJar();
    const stored = (session as StealthSession).storageState?.cookies;
    const host = new URL(origin).hostname;
    if (Array.isArray(stored) && stored.length) {
        for (const item of stored) {
            const domain = String(item.domain ?? "").replace(/^\./, "");
            if (!(host === domain || (String(item.domain).startsWith(".") && host.endsWith(`.${domain}`)))) continue;
            jar.setCookieSync(new Cookie({ key: item.name, value: item.value, domain: String(item.domain).startsWith(".") ? domain : undefined, hostOnly: !String(item.domain).startsWith("."), path: item.path || "/", secure: item.secure, httpOnly: item.httpOnly, expires: item.expires > 0 ? new Date(item.expires * 1000) : "Infinity" }), origin, { ignoreError: true });
        }
    } else {
        for (const cookie of session.cookies.split(";")) if (cookie.includes("=")) jar.setCookieSync(cookie.trim(), origin, { ignoreError: true });
    }
    return jar;
}

export function exportJarSession(jar: CookieJar, origin: string, csrfToken: string | null, previous: NamecheapSession): StealthSession {
    const cookies = jar.getCookiesSync(origin, { allPaths: true });
    return {
        cookies: jar.getCookieStringSync(origin), csrfToken, savedAt: new Date().toISOString(),
        storageState: {
            origins: (previous as StealthSession).storageState?.origins ?? [],
            cookies: cookies.map(cookie => ({
                name: cookie.key, value: cookie.value,
                domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}`,
                path: cookie.path ?? "/", expires: Number.isFinite(cookie.expiryTime()) ? (cookie.expiryTime() ?? Infinity) / 1000 : -1,
                httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: "Lax",
            })),
        },
    };
}
