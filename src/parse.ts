import type { NamecheapForward } from "./types.js";

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

/**
 * Parses the raw HTML/JSON response from Namecheap's GetDomainDetailsTabOverView endpoint.
 */
export function parseForwardersResponse(text: string): NamecheapForward[] {
    if (isCloudflareBlock(text)) {
        throw new Error("CLOUDFLARE_BLOCKED");
    }
    if (isLoginRedirect(text)) {
        return [];
    }

    // 1. Try parsing direct JSON
    try {
        const data = JSON.parse(text) as {
            Result?: {
                RedirectEmailDetails?: RawForwarder[];
                Forwarders?: RawForwarder[];
            } | string;
        };
        if (data.Result) {
            let resultData = data.Result;
            if (typeof resultData === "string") {
                try {
                    resultData = JSON.parse(resultData);
                } catch {}
            }

            if (typeof resultData === "object" && resultData !== null) {
                if (Array.isArray(resultData.RedirectEmailDetails)) {
                    return resultData.RedirectEmailDetails.map((f) => ({
                        alias: f.MailBox || f.MailboxName || f.alias || "",
                        forwardTo: f.ForwardTo || f.forwardTo || "",
                        mailboxId: f.MailBoxId || f.MailboxId || f.mailboxId,
                    }));
                }

                if (Array.isArray(resultData.Forwarders)) {
                    return resultData.Forwarders.map((f) => ({
                        alias: f.MailboxName || f.MailBox || f.alias || "",
                        forwardTo: f.ForwardTo || f.forwardTo || "",
                        mailboxId: f.MailboxId || f.MailBoxId || f.mailboxId,
                    }));
                }
            }
        }
    } catch {
        // Not direct JSON
    }

    // 2. Check for script window.nc_state = {...}
    const stateMatch = text.match(/window\.nc_state\s*=\s*({[\s\S]*?});/);
    if (stateMatch) {
        try {
            const state = JSON.parse(stateMatch[1]) as {
                DomainDetails?: {
                    Forwarders?: RawForwarder[];
                    RedirectEmailDetails?: RawForwarder[];
                };
            };
            const list = state?.DomainDetails?.Forwarders || state?.DomainDetails?.RedirectEmailDetails;
            if (Array.isArray(list)) {
                return list.map((f) => ({
                    alias: f.MailboxName || f.MailBox || f.alias || "",
                    forwardTo: f.ForwardTo || f.forwardTo || "",
                    mailboxId: f.MailboxId || f.MailBoxId || f.mailboxId,
                }));
            }
        } catch {}
    }

    // 3. Fallback to HTML data attribute parsing
    const fromHtml = parseForwardersFromHtml(text);
    if (fromHtml.length > 0) {
        return fromHtml;
    }

    return [];
}
