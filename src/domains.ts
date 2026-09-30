import { formatDomain } from "./helpers.js";
import { NamecheapApiError, type NamecheapDomain } from "./types.js";

export function parseDomainPage(text: string): { domains: NamecheapDomain[]; total: number } {
    let data: { Data?: unknown[]; TotalItems?: number };
    try { data = JSON.parse(text); } catch { throw new NamecheapApiError("Unrecognized domain-list response."); }
    if (!data || !Array.isArray(data.Data) || !Number.isInteger(data.TotalItems) || data.TotalItems! < 0) throw new NamecheapApiError("Unrecognized domain-list response.");
    const domains = data.Data.map(item => {
        if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).DomainName !== "string") throw new NamecheapApiError("Unrecognized domain-list entry.");
        const row = item as Record<string, unknown>;
        const date = typeof row.ExpireDateTime === "string" ? new Date(row.ExpireDateTime) : null;
        return {
            domain: formatDomain(row.DomainName as string),
            expiresAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
            autoRenew: row.AutoRenew === true,
            blocked: row.IsBlocked === true,
        };
    });
    return { domains, total: data.TotalItems! };
}

/** Account endpoint pages are independent of the dashboard's visual pagination. */
export async function collectDomains(fetchPage: (page: number, size: number) => Promise<{ domains: NamecheapDomain[]; total: number }>): Promise<NamecheapDomain[]> {
    const result = new Map<string, NamecheapDomain>();
    for (let page = 1; page <= 200; page++) {
        const data = await fetchPage(page, 2000);
        const before = result.size;
        for (const domain of data.domains) result.set(domain.domain, domain);
        if (result.size >= data.total) return [...result.values()].sort((a, b) => a.domain.localeCompare(b.domain));
        if (result.size === before) throw new NamecheapApiError("Domain pagination did not advance. Refusing to return an incomplete list.");
    }
    throw new NamecheapApiError("Domain list exceeded the pagination limit.");
}

/** Exact matches take precedence over a unique case-insensitive substring. */
export function chooseDomain(domains: NamecheapDomain[], query: string): NamecheapDomain {
    const value = query.trim().toLowerCase();
    if (!value) throw new Error("Enter a domain name or a unique part of its name.");
    const exact = domains.find(item => item.domain === value);
    if (exact) return exact;
    const matches = domains.filter(item => item.domain.includes(value));
    if (!matches.length) throw new Error(`No account domain matches "${query}". Run ncf domains.`);
    if (matches.length > 1) throw new Error(`Several account domains match "${query}". Use the full name from ncf domains.`);
    return matches[0];
}
