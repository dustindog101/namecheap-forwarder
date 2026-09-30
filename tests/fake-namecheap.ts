import http from "node:http";
import type { AddressInfo } from "node:net";

export const GOOD_COOKIES = "auth=good; x-ncpl-csrf=csrf123";

type Forward = { MailBox: string; ForwardTo: string; MailBoxId: number };

/**
 * In-memory stand-in for Namecheap's dashboard API, mimicking the behaviour that matters:
 * - expired cookies get a 302 to the login page (not a 401)
 * - rejected changes still answer HTTP 200 with { Result: false, Msg }
 * - the list endpoint returns Result as a JSON-encoded string
 * - optional 429s and latency, and it records peak request concurrency
 */
export async function startFakeNamecheap(options: { latencyMs?: number; rateLimitEvery?: number; limit?: number; csrfToken?: string } = {}) {
    const domains = new Map<string, Forward[]>([
        ["alpha.test", []],
        ["beta.test", []],
    ]);
    let nextId = 1;
    let inFlight = 0;
    let requests = 0;
    const stats = { maxConcurrent: 0, requests: 0, rateLimited: 0, paths: [] as string[] };

    const server = http.createServer(async (req, res) => {
        stats.paths.push(req.url ?? "");
        inFlight++;
        stats.maxConcurrent = Math.max(stats.maxConcurrent, inFlight);
        stats.requests = ++requests;
        const body = await new Promise<string>((resolve) => {
            let data = "";
            req.on("data", (c) => (data += c));
            req.on("end", () => resolve(data));
        });
        if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));

        const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
            inFlight--;
            res.writeHead(status, { "content-type": "application/json", ...headers });
            res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
        };

        if (options.rateLimitEvery && requests % options.rateLimitEvery === 0) {
            stats.rateLimited++;
            return send(429, "<html>Too many requests</html>");
        }
        if (!req.headers.cookie?.includes("auth=good")) {
            return send(302, "", { location: "https://www.namecheap.com/myaccount/login/?ReturnUrl=%2fdomains" });
        }

        const url = new URL(req.url!, "http://x");
        if (req.method === "GET" && url.pathname.startsWith("/domains/domaincontrolpanel/")) {
            return send(200, `<input name="ncCompliance" type="hidden" value="${options.csrfToken ?? "csrf123"}">`, { "set-cookie": "dashboardToken=ready; Path=/; HttpOnly" });
        }
        if (req.method === "GET" && url.pathname === "/Domains/DomainDetails/GetDomainDetailsTabOverView") {
            const list = domains.get(url.searchParams.get("domainName") ?? "");
            if (!list) return send(200, { Result: null, Msg: "Domain not found" });
            return send(200, { Result: JSON.stringify({ RedirectEmailDetails: list }) });
        }

        if (req.method === "GET" && url.pathname === "/domains/") return send(200, '<a href="/myaccount/logout">Log out</a>');
        if (req.method === "POST" && url.pathname === "/api/v1/ncpl/gatewaydomainlist/getdomainsonly") {
            if (req.headers["x-ncpl-rcsrf"] !== "csrf123") return send(403, "Invalid token");
            const { gridPageRequestViewModel: page } = JSON.parse(body);
            const rows = [...domains.keys()].map(DomainName => ({ DomainName, AutoRenew: true, IsBlocked: false, ExpireDateTime: "2027-01-01" }));
            return send(200, { Data: rows.slice((page.Page - 1) * page.PageSize, page.Page * page.PageSize), TotalItems: rows.length });
        }
        if (req.method === "POST") {
            if (req.headers["_nccompliance"] !== (options.csrfToken ?? "csrf123")) return send(200, { Result: null, Msg: "A required anti-forgery token was not supplied or was invalid" });
            if (options.csrfToken && !req.headers.cookie?.includes("dashboardToken=ready")) return send(200, { Result: null, Msg: "A required anti-forgery token was not supplied or was invalid" });
            const json = JSON.parse(body);
            if (url.pathname === "/Domains/AddForwarder") {
                const list = domains.get(json.domainName);
                if (!list) return send(200, { Result: false, Msg: "Domain not found" });
                if (list.some((f) => f.MailBox === json.mailBox && f.ForwardTo === json.forwardTo)) {
                    return send(200, { Result: false, Msg: "Forwarder already exists" });
                }
                if (list.length >= (options.limit ?? 100)) return send(200, { Result: false, Msg: "Maximum forwarders reached" });
                list.push({ MailBox: json.mailBox, ForwardTo: json.forwardTo, MailBoxId: nextId++ });
                return send(200, { Result: true });
            }
            if (url.pathname === "/Domains/DeleteForwarder") {
                const list = domains.get(json.model.DomainName);
                if (!list) return send(200, { Result: false, Msg: "Domain not found" });
                let removed = 0;
                for (const f of json.model.Forwarders) {
                    const i = list.findIndex((x) => x.MailBox === f.MailboxName && x.ForwardTo === f.ForwardTo);
                    if (i >= 0) {
                        list.splice(i, 1);
                        removed++;
                    }
                }
                return send(200, removed ? { Result: true } : { Result: false, Msg: "Forwarder not found" });
            }
        }
        send(404, "Not found");
    });

    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        domains,
        stats,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
