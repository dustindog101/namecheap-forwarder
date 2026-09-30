import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NamecheapClient } from "../src/client.js";
import { RequestQueue } from "../src/helpers.js";
import { syncForwarders } from "../src/sync.js";
import { NamecheapApiError, SessionExpiredError } from "../src/types.js";
import { GOOD_COOKIES, startFakeNamecheap } from "./fake-namecheap.js";

const run = promisify(execFile);
const CLI = path.resolve(__dirname, "../bin/cli.mjs");
const good = { cookies: GOOD_COOKIES, csrfToken: null };
let fake: Awaited<ReturnType<typeof startFakeNamecheap>> | undefined;

afterEach(async () => {
    await fake?.close();
    fake = undefined;
});

const client = (domain: string, extra: object = {}, session = good) =>
    new NamecheapClient(session, domain, { baseUrl: fake!.baseUrl, minIntervalMs: 0, retryDelayMs: 10, ...extra });

describe("NamecheapClient against a fake Namecheap", () => {
    it("recovers the dashboard token after a rejection, caches it, and applies the change once", async () => {
        fake = await startFakeNamecheap({ csrfToken: "dashboard-token" });
        const c = client("alpha.test");
        await c.addForwarder("first", "a@mail.test");
        expect(fake.stats.requests).toBe(3); // rejection, token GET, accepted add
        await c.addForwarder("second", "a@mail.test");
        expect(fake.stats.requests).toBe(4);
        expect(await c.listForwarders()).toHaveLength(2);
        expect(fake.stats.maxConcurrent).toBe(1);
    });

    it("adds, lists and removes forwards on separate domains", async () => {
        fake = await startFakeNamecheap();
        const alpha = client("alpha.test");
        const beta = client("BETA.test");

        await alpha.addForwarder("support", "a@mail.test");
        await beta.addForwarder("support", "b@mail.test");
        await beta.addForwarder("*", "catch@mail.test");

        expect(await alpha.listForwarders()).toEqual([{ alias: "support", forwardTo: "a@mail.test", mailboxId: 1 }]);
        expect((await beta.listForwarders()).map((f) => f.alias)).toEqual(["support", "*"]);

        await beta.deleteForwarder("support", "b@mail.test");
        expect((await beta.listForwarders()).map((f) => f.alias)).toEqual(["*"]);
        expect(await alpha.listForwarders()).toHaveLength(1);
    });

    it("treats an existing forward as success", async () => {
        fake = await startFakeNamecheap();
        const c = client("alpha.test");
        expect((await c.addForwarder("hi", "x@mail.test")).alreadyExisted).toBe(false);
        expect((await c.addForwarder("hi", "x@mail.test")).alreadyExisted).toBe(true);
    });

    it("reports rejected changes instead of pretending they worked", async () => {
        fake = await startFakeNamecheap();
        await expect(client("alpha.test").deleteForwarder("nope", "x@mail.test")).rejects.toThrow(NamecheapApiError);
        await expect(client("unknown.test").addForwarder("a", "x@mail.test")).rejects.toThrow(/Domain not found/);
    });

    it("detects an expired session instead of returning an empty list", async () => {
        fake = await startFakeNamecheap();
        const expired = client("alpha.test", {}, { cookies: "auth=old", csrfToken: "csrf123" });
        await expect(expired.listForwarders()).rejects.toThrow(SessionExpiredError);
        await expect(expired.addForwarder("a", "x@mail.test")).rejects.toThrow(SessionExpiredError);
        expect(await expired.isSessionValid()).toBe(false);
        expect(await client("alpha.test").isSessionValid()).toBe(true);
    });

    it("serializes concurrent calls and keeps every change", async () => {
        fake = await startFakeNamecheap({ latencyMs: 5 });
        const queue = new RequestQueue({ minIntervalMs: 0 });
        const alpha = client("alpha.test", { queue });
        const beta = client("beta.test", { queue });

        await Promise.all(
            Array.from({ length: 20 }, (_, i) => (i % 2 ? alpha : beta).addForwarder(`user${i}`, `u${i}@mail.test`))
        );

        expect(fake.stats.maxConcurrent).toBe(1);
        expect(await alpha.listForwarders()).toHaveLength(10);
        expect(await beta.listForwarders()).toHaveLength(10);
    });

    it("retries through 429 rate limits", async () => {
        fake = await startFakeNamecheap({ rateLimitEvery: 3 });
        const c = client("alpha.test");
        for (let i = 0; i < 6; i++) await c.addForwarder(`r${i}`, `r${i}@mail.test`);
        expect(fake.stats.rateLimited).toBeGreaterThan(0);
        expect(await c.listForwarders()).toHaveLength(6);
    });

    it("deletes several forwards in one request", async () => {
        fake = await startFakeNamecheap();
        const c = client("alpha.test");
        await c.addForwarder("a", "a@mail.test");
        await c.addForwarder("b", "b@mail.test");
        const before = fake.stats.requests;
        await c.deleteForwarders([
            { alias: "a", forwardTo: "a@mail.test" },
            { alias: "b", forwardTo: "b@mail.test" },
        ]);
        expect(fake.stats.requests - before).toBe(1);
        expect(await c.listForwarders()).toEqual([]);
    });
});

describe("syncForwarders against a fake Namecheap", () => {
    it("syncs multi-destination aliases, changes destinations and prunes", async () => {
        fake = await startFakeNamecheap();
        const c = client("alpha.test");
        await c.addForwarder("old", "old@mail.test");
        await c.addForwarder("support", "before@mail.test");
        await c.addForwarder("*", "catch@mail.test");

        const summary = await syncForwarders(
            c,
            { support: "after@mail.test", team: ["one@mail.test", "two@mail.test"] },
            { keep: ["*"] }
        );

        expect(summary.errors).toEqual([]);
        expect(summary.added).toHaveLength(3);
        expect(summary.removed).toEqual([
            { alias: "old", forwardTo: "old@mail.test" },
            { alias: "support", forwardTo: "before@mail.test" },
        ]);
        const after = (await c.listForwarders()).map((f) => `${f.alias}>${f.forwardTo}`).sort();
        expect(after).toEqual(["*>catch@mail.test", "support>after@mail.test", "team>one@mail.test", "team>two@mail.test"]);

        const again = await syncForwarders(c, { support: "after@mail.test", team: ["one@mail.test", "two@mail.test"] }, { keep: ["*"] });
        expect(again.added).toEqual([]);
        expect(again.removed).toEqual([]);
    });

    it("keeps the old destination when adding the new one fails", async () => {
        fake = await startFakeNamecheap({ limit: 1 });
        const c = client("alpha.test");
        await c.addForwarder("support", "before@mail.test");

        const summary = await syncForwarders(c, { support: "after@mail.test" }, { prune: false });
        expect(summary.errors[0]).toMatchObject({ op: "add", alias: "support" });
        expect(await c.listForwarders()).toHaveLength(1);
    });

    it("aborts on an expired session", async () => {
        fake = await startFakeNamecheap();
        await expect(
            syncForwarders(client("alpha.test", {}, { cookies: "auth=old", csrfToken: null }), { a: "a@mail.test" })
        ).rejects.toThrow(SessionExpiredError);
    });
});

describe("CLI against a fake Namecheap", () => {
    let sessionDir: string;

    beforeAll(async () => {
        await fs.access(path.resolve(__dirname, "../dist/cli.js")).catch(() => {
            throw new Error("Run `npm run build` before the CLI tests");
        });
    });

    const cli = async (args: string[], env: Record<string, string> = {}) => {
        try {
            const { stdout, stderr } = await run("node", [CLI, ...args], {
                env: { ...process.env, NAMECHEAP_BASE_URL: fake!.baseUrl, NAMECHEAP_SESSION_DIR: sessionDir, NAMECHEAP_DOMAIN: "", ...env },
            });
            return { code: 0, stdout, stderr };
        } catch (err) {
            const e = err as { code: number; stdout: string; stderr: string };
            return { code: e.code, stdout: e.stdout, stderr: e.stderr };
        }
    };

    const withSession = async (cookies: string) => {
        sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "ncf-"));
        await fs.writeFile(path.join(sessionDir, "default.session.json"), JSON.stringify({ cookies, csrfToken: null }));
    };

    it("reuses a validated session for login without requiring a browser or new credentials", async () => {
        fake = await startFakeNamecheap();
        await withSession(GOOD_COOKIES);
        const result = await cli(["login", "-d", "alpha.test", "--json"]);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, reused: true, credentialsSaved: false });
        expect(fake.stats.requests).toBe(1);
    });

    it("prints help and structured argument errors without contacting Namecheap", async () => {
        fake = await startFakeNamecheap();
        await withSession(GOOD_COOKIES);
        expect((await cli(["--help"])).code).toBe(0);
        const result = await cli(["unknown-command", "--json"]);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
        const invalid = await cli(["add", "bad alias@alpha.test", "a@mail.test", "--json"]);
        expect(JSON.parse(invalid.stdout).error.message).toMatch(/Invalid alias/);
        expect(fake.stats.requests, JSON.stringify(fake.stats.paths)).toBe(0);
    });

    it("logout clears both secrets and session by default, and session-only preserves secrets", async () => {
        fake = await startFakeNamecheap();
        await withSession(GOOD_COOKIES);
        const credentials = path.join(sessionDir, "default.credentials.json");
        await fs.writeFile(credentials, JSON.stringify({ username: "fixture", password: "fixture-password" }));
        const first = await cli(["logout", "--session-only", "--json"]);
        expect(JSON.parse(first.stdout)).toMatchObject({ sessionRemoved: true, credentialsRemoved: false });
        await fs.access(credentials);
        const second = await cli(["logout", "--json"]);
        expect(JSON.parse(second.stdout)).toMatchObject({ sessionRemoved: false, credentialsRemoved: true });
        await expect(fs.access(credentials)).rejects.toThrow();
    });

    it("discovers and selects domains, honors explicit overrides, and clears without HTTP", async () => {
        fake = await startFakeNamecheap();
        await withSession(GOOD_COOKIES);
        expect(JSON.parse((await cli(["domains", "--json"])).stdout).map((x: { domain: string }) => x.domain)).toEqual(["alpha.test", "beta.test"]);
        expect(JSON.parse((await cli(["domains", "beta", "--json"])).stdout)).toHaveLength(1);
        expect((await cli(["use", "test", "--json"])).code).toBe(1);
        expect(JSON.parse((await cli(["use", "alpha", "--json"])).stdout).domain).toBe("alpha.test");
        expect((await cli(["add", "chosen", "a@mail.test", "--json"])).code).toBe(0);
        expect((await cli(["add", "override", "b@mail.test", "-d", "beta.test", "--json"])).code).toBe(0);
        expect(JSON.parse((await cli(["ls", "--json"])).stdout)[0].alias).toBe("chosen");
        expect(JSON.parse((await cli(["ls", "beta.test", "--json"])).stdout)[0].alias).toBe("override");
        expect(JSON.parse((await cli(["ls", "--json"], { NAMECHEAP_DOMAIN: "beta.test" })).stdout)[0].alias).toBe("override");
        expect((await cli(["add", "full@alpha.test", "a@mail.test", "--json"], { NAMECHEAP_DOMAIN: "beta.test" })).code).toBe(0);
        expect((await cli(["add", "full@alpha.test", "a@mail.test", "-d", "beta.test", "--json"])).code).toBe(1);
        const requests = fake.stats.requests;
        expect((await cli(["use", "--clear", "--json"])).code).toBe(0);
        expect(fake.stats.requests).toBe(requests);
        expect(JSON.parse((await cli(["status", "--json"])).stdout)).toMatchObject({ domain: null, valid: true });
        expect((await cli(["ls", "--json"])).code).toBe(1);
    });

    it("adds, lists (clean JSON on stdout) and removes across domains", async () => {
        fake = await startFakeNamecheap();
        await withSession(GOOD_COOKIES);

        expect((await cli(["add", "support@alpha.test", "a@mail.test", "b@mail.test"])).code).toBe(0);
        expect((await cli(["add", "hello", "h@mail.test", "-d", "beta.test"])).code).toBe(0);

        const list = await cli(["list", "alpha.test", "--json"]);
        expect(list.code).toBe(0);
        expect(JSON.parse(list.stdout).map((f: { forwardTo: string }) => f.forwardTo)).toEqual(["a@mail.test", "b@mail.test"]);

        expect((await cli(["rm", "support@alpha.test", "b@mail.test"])).code).toBe(0);
        expect(JSON.parse((await cli(["ls", "alpha.test", "--json"])).stdout)).toHaveLength(1);
        expect(JSON.parse((await cli(["ls", "beta.test", "--json"])).stdout)).toHaveLength(1);

        const missing = await cli(["rm", "nobody@alpha.test"]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toMatch(/No forward found/);
    });

    it("syncs from a file, refusing to prune without --yes when not interactive", async () => {
        fake = await startFakeNamecheap();
        await withSession(GOOD_COOKIES);
        await cli(["add", "stale@alpha.test", "s@mail.test"]);
        const file = path.join(sessionDir, "forwards.json");
        await fs.writeFile(file, JSON.stringify({ support: "a@mail.test" }));

        const dry = await cli(["sync", file, "-d", "alpha.test", "--dry-run", "--json"]);
        expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, toAdd: [{ alias: "support" }], toRemove: [{ alias: "stale" }] });

        const refused = await cli(["sync", file, "-d", "alpha.test"]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toMatch(/--yes/);

        expect((await cli(["sync", file, "-d", "alpha.test", "--yes"])).code).toBe(0);
        const after = JSON.parse((await cli(["ls", "alpha.test", "--json"])).stdout);
        expect(after.map((f: { alias: string }) => f.alias)).toEqual(["support"]);
    });

    it("exits 3 with a login hint when the session is expired or missing", async () => {
        fake = await startFakeNamecheap();
        await withSession("auth=old");
        const expired = await cli(["list", "alpha.test"]);
        expect(expired.code).toBe(3);
        expect(expired.stderr).toMatch(/ncf login/);

        const status = await cli(["status", "-d", "alpha.test", "--json"]);
        expect(status.code).toBe(3);
        expect(JSON.parse(status.stdout).valid).toBe(false);

        sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "ncf-"));
        const missing = await cli(["list", "alpha.test", "--json"]);
        expect(missing.code).toBe(3);
        expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { code: "SESSION_EXPIRED" } });
    });

    it("rejects invalid input before calling Namecheap", async () => {
        fake = await startFakeNamecheap();
        await withSession(GOOD_COOKIES);
        expect((await cli(["add", "bad alias@alpha.test", "a@mail.test"])).stderr).toMatch(/Invalid alias/);
        expect((await cli(["add", "ok@alpha.test", "not-an-email"])).stderr).toMatch(/Invalid destination/);
        expect((await cli(["add", "ok", "a@mail.test"])).stderr).toMatch(/No domain given/);
        expect(fake.stats.requests, JSON.stringify(fake.stats.paths)).toBe(0);
    });
});
