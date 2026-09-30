import { Command, CommanderError, Option } from "commander";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { startBrowserServer } from "./browser-server.js";
import { NamecheapClient } from "./client.js";
import { formatDomain, getSessionAgeHours, normalizeAlias, normalizeEmail, resolveCsrfToken, splitAddress } from "./helpers.js";
import { chooseDomain } from "./domains.js";
import { selectedDomain, selectDomain, clearDomain } from "./settings.js";
import { promptLoginValue } from "./login-profile.js";
import { deleteLoginProfile, loadLoginProfile } from "./login-profile.js";
import { loginAccount } from "./login.js";
import { SessionManager } from "./session-manager.js";
import { StealthNamecheapClient } from "./stealth-client.js";
import { planSync, syncForwarders } from "./sync.js";
import { CloudflareBlockedError, NamecheapError, SessionExpiredError, type NamecheapClientLike, type StealthSession } from "./types.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Exit codes: 0 ok, 1 error, 2 sync finished with some failed changes, 3 login required. */
const EXIT_ERROR = 1;
const EXIT_PARTIAL = 2;
const EXIT_AUTH = 3;

type GlobalOptions = { domain?: string; domainExplicit?: boolean; profile: string; stealth?: boolean; json?: boolean };

class CliError extends Error {
    constructor(message: string, public exitCode = EXIT_ERROR) {
        super(message);
    }
}

// Human-readable progress goes to stderr so stdout stays clean for --json and piping.
const log = (message: string) => console.error(message);

async function resolveDomain(opts: GlobalOptions, fromAddress?: string | null): Promise<string> {
    const domain = fromAddress || opts.domain || process.env.NAMECHEAP_DOMAIN || await selectedDomain(opts.profile);
    if (!domain) {
        throw new CliError("No domain given. Run ncf domains then ncf use example.com, use a full address, or pass -d example.com.");
    }
    return formatDomain(domain);
}

/** Accepts "support" (with -d) or "support@example.com". */
async function parseAddress(address: string, opts: GlobalOptions): Promise<{ alias: string; domain: string }> {
    const split = splitAddress(address);
    const domain = await resolveDomain(opts, split?.domain);
    if (split && opts.domainExplicit && opts.domain && formatDomain(opts.domain) !== split.domain) {
        throw new CliError(`Address ${address} does not match --domain ${opts.domain}.`);
    }
    return { alias: normalizeAlias(split ? split.alias : address), domain };
}

async function loadSession(opts: GlobalOptions): Promise<{ session: StealthSession; fromEnv: boolean; manager: SessionManager }> {
    const manager = new SessionManager();
    const envSession = SessionManager.fromEnv();
    if (envSession) return { session: envSession, fromEnv: true, manager };
    const session = await manager.loadSession(opts.profile);
    if (!session) {
        const flag = opts.profile === "default" ? "" : ` --profile ${opts.profile}`;
        const saved = await loadLoginProfile(manager, opts.profile);
        if ((saved?.username && saved.password) || (process.env.NAMECHEAP_USERNAME && process.env.NAMECHEAP_PASSWORD)) {
            log("No saved session. Signing in with saved credentials...");
            const result = await loginAccount({ profile: opts.profile, domain: opts.domain, interactive: false, log }, manager);
            return { session: result.session, fromEnv: false, manager };
        }
        throw new SessionExpiredError(`Not logged in. Run: ncf login${flag}`);
    }
    return { session, fromEnv: false, manager };
}

/** Routes each operation independently so a fallback never replays an entire sync or batch. */
export async function withClient<T>(opts: GlobalOptions, domain: string | undefined, fn: (client: NamecheapClientLike) => Promise<T>): Promise<T> {
    const loaded = await loadSession(opts);
    let session = loaded.session;
    const { fromEnv, manager } = loaded;
    let direct = new NamecheapClient(session, domain);
    let browser: StealthNamecheapClient | undefined;
    let useBrowser = Boolean(opts.stealth || ["1", "true"].includes(process.env.NAMECHEAP_STEALTH ?? ""));
    let recovered = false;
    const activeClient = () => {
        if (!useBrowser) return direct;
        browser ??= new StealthNamecheapClient(session, domain, { wsEndpoint: process.env.NAMECHEAP_BROWSER_WS });
        return browser;
    };
    const execute = async <R>(operation: (client: NamecheapClientLike) => Promise<R>): Promise<R> => {
        try { return await operation(activeClient()); }
        catch (error) {
            if (error instanceof CloudflareBlockedError && !useBrowser) {
                log("Blocked by Cloudflare. Retrying this operation in a headless browser...");
                useBrowser = true;
                return execute(operation);
            }
            if (error instanceof SessionExpiredError && !fromEnv && !recovered) {
                const saved = await loadLoginProfile(manager, opts.profile);
                if (saved?.username && saved.password) {
                    recovered = true;
                    log("Session expired. Signing in with saved credentials...");
                    const result = await loginAccount({ profile: opts.profile, fresh: true, interactive: false, log }, manager);
                    session = result.session;
                    await browser?.close();
                    browser = undefined;
                    direct = new NamecheapClient(session, domain);
                    return execute(operation);
                }
            }
            throw error;
        }
    };
    const routed: NamecheapClientLike = {
        listDomains: () => execute(client => {
            if (!client.listDomains) throw new CliError("This client does not support domain discovery.");
            return client.listDomains();
        }),
        listForwarders: () => execute(client => client.listForwarders()),
        addForwarder: (alias, target) => execute(client => client.addForwarder(alias, target)),
        deleteForwarder: (alias, target) => execute(client => client.deleteForwarder(alias, target)),
    };
    try {
        const result = await fn(routed);
        if (!fromEnv) {
            const refreshed = useBrowser ? await browser?.exportSession() : direct.exportSession();
            if (refreshed) await manager.saveSession(refreshed, opts.profile);
        }
        return result;
    } finally { await browser?.close(); }
}

function printTable(rows: string[][]) {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    for (const [i, row] of rows.entries()) {
        console.log(row.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd());
        if (i === 0) console.log(widths.map((w) => "-".repeat(w)).join("  "));
    }
}

async function confirm(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
}

const program = new Command()
    .name("ncf")
    .description("Manage Namecheap email forwarding from the command line (unofficial).")
    .version(version)
    .addOption(new Option("-d, --domain <domain>", "domain to manage").env("NAMECHEAP_DOMAIN"))
    .addOption(new Option("-p, --profile <name>", "saved session to use (one per Namecheap account)").default("default").env("NAMECHEAP_PROFILE"))
    .option("--stealth", "always use a headless browser (slower; bypasses Cloudflare challenges)")
    .option("--json", "machine-readable output on stdout")
    .exitOverride()
    .showHelpAfterError()
    .addHelpText(
        "after",
        `
Examples:
  ncf login
  ncf domains
  ncf use example.com
  ncf list
  ncf add support@example.com you@gmail.com
  ncf remove support@example.com
  ncf sync forwards.json -d example.com --dry-run

Sessions are stored in ~/.config/namecheap-forwarder (override with NAMECHEAP_SESSION_DIR).
Exit codes: 0 ok, 1 error, 2 sync partially failed, 3 login required.`
    );

const globals = (cmd: Command): GlobalOptions => ({ ...cmd.optsWithGlobals(), domainExplicit: cmd.getOptionValueSourceWithGlobals("domain") === "cli" }) as GlobalOptions;

program
    .command("domains")
    .description("list account domains over HTTP; optionally filter by part of a name")
    .argument("[filter]", "case-insensitive part of a domain name")
    .action(async (filter: string | undefined, _: unknown, cmd: Command) => {
        const opts = globals(cmd);
        const all = await withClient(opts, undefined, client => client.listDomains!());
        const domains = filter ? all.filter(item => item.domain.includes(filter.trim().toLowerCase())) : all;
        const active = await selectedDomain(opts.profile);
        if (opts.json) console.log(JSON.stringify(domains.map(item => ({ ...item, selected: item.domain === active })), null, 2));
        else {
            if (domains.length) printTable([["DOMAIN", "EXPIRES", "AUTO-RENEW", "SELECTED"], ...domains.map(item => [item.domain, item.expiresAt?.slice(0, 10) ?? "unknown", item.autoRenew ? "on" : "off", item.domain === active ? "*" : ""])]);
            log(`${domains.length} domain${domains.length === 1 ? "" : "s"}${filter ? " matched" : " in this account"}. Select one: ncf use <domain>`);
        }
    });

program
    .command("use")
    .description("select a default domain for this profile (exact name or unique substring)")
    .argument("[domain]", "domain or unique part of a domain; omit for a terminal picker")
    .option("--clear", "clear the saved domain selection")
    .action(async (query: string | undefined, options: { clear?: boolean }, cmd: Command) => {
        const opts = globals(cmd);
        if (options.clear && query) throw new CliError("Choose a domain or --clear, not both.");
        if (options.clear) {
            await clearDomain(opts.profile);
            if (opts.json) console.log(JSON.stringify({ profile: opts.profile, domain: null }));
            else log(`Cleared the default domain for profile "${opts.profile}".`);
            return;
        }
        if (!query && (!process.stdin.isTTY || opts.json)) throw new CliError("Pass a domain: ncf use example.com. Run ncf domains to see choices.");
        const domains = await withClient(opts, undefined, client => client.listDomains!());
        if (!domains.length) throw new CliError("This account has no domains to select.");
        if (!query) {
            domains.forEach((item, index) => log(`  ${index + 1}. ${item.domain}`));
            const answer = await promptLoginValue("Select a number or domain: ");
            query = /^\d+$/.test(answer) ? domains[Number(answer) - 1]?.domain : answer;
            if (!query) throw new CliError("Invalid selection. Run ncf use again.");
        }
        const domain = chooseDomain(domains, query);
        if (domain.blocked) throw new CliError("This domain is blocked in Namecheap. Resolve its status in the dashboard first.");
        await selectDomain(opts.profile, domain.domain);
        if (opts.json) console.log(JSON.stringify({ profile: opts.profile, domain: domain.domain }));
        else log(`Using ${domain.domain} for profile "${opts.profile}". Override once with -d <domain> or a full address.`);
    });

program
    .command("login")
    .description("headless login; reuse the session or saved credentials, save credentials by default")
    .option("--headless", "terminal login without a visible browser (default)")
    .option("--browser", "sign in manually in a visible browser")
    .option("--save-credentials", "set up or replace credentials for automatic login (saved by default)")
    .option("--no-save-credentials", "do not write username, password or authenticator setup")
    .option("--totp-secret", "prompt privately for a Base32 secret or otpauth URI")
    .option("--totp-qr <file>", "import the authenticator setup from a PNG/JPEG QR image")
    .option("--fresh", "ignore the saved session and authenticate again")
    .action(async (options: { headless?: boolean; browser?: boolean; saveCredentials: boolean; totpSecret?: boolean; totpQr?: string; fresh?: boolean }, cmd: Command) => {
        const opts = globals(cmd);
        if (options.browser && options.headless) throw new Error("Choose --browser or --headless.");
        const manager = new SessionManager();
        const result = await loginAccount({ ...options, profile: opts.profile, domain: opts.domain,
            setupCredentials: cmd.getOptionValueSource("saveCredentials") === "cli" && options.saveCredentials,
            log,
        }, manager);
        const path = manager.getSessionPath(opts.profile);
        if (opts.json) console.log(JSON.stringify({ ok: true, profile: opts.profile, path, reused: result.reused, credentialsSaved: result.credentialsSaved, csrfToken: Boolean(result.session.csrfToken) }));
        else log(`Logged in as profile "${opts.profile}". Session: ${path}`);
    });

program
    .command("logout")
    .description("remove the saved session and login secrets for this profile")
    .option("--session-only", "keep credentials and authenticator setup for automatic login")
    .action(async (options: { sessionOnly?: boolean }, cmd: Command) => {
        const opts = globals(cmd);
        const manager = new SessionManager();
        const sessionRemoved = await manager.deleteSession(opts.profile);
        const credentialsRemoved = options.sessionOnly ? false : await deleteLoginProfile(manager, opts.profile);
        if (opts.json) console.log(JSON.stringify({ profile: opts.profile, sessionRemoved, credentialsRemoved }));
        else log(`Profile "${opts.profile}": ${options.sessionOnly ? "session removed; login secrets kept" : "session and login secrets removed"}.`);
    });

program
    .command("status")
    .alias("check")
    .description("show the saved session and verify Namecheap still accepts it")
    .action(async (_: unknown, cmd: Command) => {
        const opts = globals(cmd);
        const { session, fromEnv, manager } = await loadSession(opts);
        const ageHours = getSessionAgeHours(session.savedAt);
        const info = {
            source: fromEnv ? "NAMECHEAP_SESSION_COOKIES" : manager.getSessionPath(opts.profile),
            savedAt: session.savedAt ?? null,
            ageHours: Number.isFinite(ageHours) ? Math.round(ageHours) : null,
            csrfToken: Boolean(resolveCsrfToken(session.csrfToken, session.cookies)),
            valid: null as boolean | null,
        };
        const domain = opts.domain || process.env.NAMECHEAP_DOMAIN || await selectedDomain(opts.profile);
        if (domain) {
            info.valid = await withClient(opts, formatDomain(domain), async (c) => {
                try {
                    await c.listForwarders();
                    return true;
                } catch (err) {
                    if (err instanceof SessionExpiredError) return false;
                    throw err;
                }
            });
        }

        if (!domain) {
            info.valid = await manager.checkSession(session);
            if (info.valid === true && !fromEnv) await manager.saveSession(session, opts.profile);
        }
        if (opts.json) console.log(JSON.stringify({ profile: opts.profile, domain: domain ?? null, ...info }, null, 2));
        else {
            log(`Session:    ${info.source}`);
            log(`Saved:      ${info.savedAt ?? "unknown"}${info.ageHours !== null ? ` (${info.ageHours}h ago)` : ""}`);
            log(`CSRF token: ${info.csrfToken ? "present" : "missing"}`);
            log(`Valid:      ${info.valid === null ? "not confirmed (try -d <domain> or ncf login)" : info.valid ? "yes" : "no — run: ncf login"}`);
        }
        if (info.valid === false) process.exitCode = EXIT_AUTH;
    });

program
    .command("list")
    .alias("ls")
    .description("list forwards on a domain")
    .argument("[domain]", "domain (or use -d)")
    .action(async (domainArg: string | undefined, _: unknown, cmd: Command) => {
        const opts = globals(cmd);
        const domain = await resolveDomain(opts, domainArg);
        const forwards = await withClient(opts, domain, (c) => c.listForwarders());

        if (opts.json) {
            console.log(JSON.stringify(forwards, null, 2));
        } else if (forwards.length === 0) {
            log(`No forwards on ${domain}.`);
        } else {
            printTable([["ALIAS", "FORWARDS TO"], ...forwards.map((f) => [`${f.alias}@${domain}`, f.forwardTo])]);
            log(`\n${forwards.length} forward${forwards.length === 1 ? "" : "s"}`);
        }
    });

program
    .command("add")
    .description("forward an alias to one or more addresses (no-op if it already exists)")
    .argument("<address>", 'alias, e.g. "support@example.com", "support" with -d, or "*" for catch-all')
    .argument("<destinations...>", "email address(es) to forward to")
    .action(async (address: string, destinations: string[], _: unknown, cmd: Command) => {
        const opts = globals(cmd);
        const { alias, domain } = await parseAddress(address, opts);
        const targets = destinations.map(normalizeEmail);
        const results = await withClient(opts, domain, async (c) => {
            const out = [];
            for (const forwardTo of targets) {
                const r = await c.addForwarder(alias, forwardTo);
                out.push({ alias, forwardTo, alreadyExisted: r.alreadyExisted });
                log(`${r.alreadyExisted ? "Exists " : "Added  "} ${alias}@${domain} -> ${forwardTo}`);
            }
            return out;
        });
        if (opts.json) console.log(JSON.stringify(results, null, 2));
    });

program
    .command("remove")
    .aliases(["rm", "delete"])
    .description("remove an alias (all its destinations, or just the ones given)")
    .argument("<address>", 'alias, e.g. "support@example.com" or "support" with -d')
    .argument("[destinations...]", "only remove forwards to these addresses")
    .action(async (address: string, destinations: string[], _: unknown, cmd: Command) => {
        const opts = globals(cmd);
        const { alias, domain } = await parseAddress(address, opts);
        const only = new Set(destinations.map((d) => normalizeEmail(d).toLowerCase()));
        const removed = await withClient(opts, domain, async (c) => {
            const matches = (await c.listForwarders()).filter(
                (f) => f.alias.toLowerCase() === alias && (only.size === 0 || only.has(f.forwardTo.toLowerCase()))
            );
            if (matches.length === 0) throw new CliError(`No forward found for ${alias}@${domain}${only.size ? ` to ${[...only].join(", ")}` : ""}.`);
            for (const f of matches) {
                await c.deleteForwarder(f.alias, f.forwardTo);
                log(`Removed ${f.alias}@${domain} -> ${f.forwardTo}`);
            }
            return matches;
        });
        if (opts.json) console.log(JSON.stringify(removed, null, 2));
    });

program
    .command("sync")
    .description("make a domain's forwards match a JSON file of { alias: destination | [destinations] }")
    .argument("<file>", "JSON file, or - for stdin")
    .option("--dry-run", "show the plan without changing anything")
    .option("--no-prune", "only add; never remove forwards missing from the file")
    .option("--keep <aliases...>", 'never remove these aliases (e.g. --keep "*")')
    .option("-y, --yes", "don't ask before removing forwards")
    .action(async (file: string, options: { dryRun?: boolean; prune: boolean; keep?: string[]; yes?: boolean }, cmd: Command) => {
        const opts = globals(cmd);
        const domain = await resolveDomain(opts);
        const raw = file === "-" ? await readStdin() : await fs.readFile(file, "utf-8");
        let desired: unknown;
        try {
            desired = JSON.parse(raw);
        } catch (err) {
            throw new CliError(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
        }

        const summary = await withClient(opts, domain, async (c) => {
            const existing = await c.listForwarders();
            const plan = planSync(existing, desired as Record<string, string>, { prune: options.prune, keep: options.keep });

            for (const f of plan.toAdd) log(`+ ${f.alias}@${domain} -> ${f.forwardTo}`);
            for (const f of plan.toRemove) log(`- ${f.alias}@${domain} -> ${f.forwardTo}`);
            log(`${plan.toAdd.length} to add, ${plan.toRemove.length} to remove, ${plan.unchanged.length} unchanged.`);

            if (options.dryRun || (plan.toAdd.length === 0 && plan.toRemove.length === 0)) {
                return { added: [], removed: [], unchanged: plan.unchanged, errors: [], plan };
            }
            if (plan.toRemove.length > 0 && !options.yes) {
                if (!process.stdin.isTTY) throw new CliError("Refusing to remove forwards without confirmation. Re-run with --yes.");
                if (!(await confirm(`Remove ${plan.toRemove.length} forward(s) from ${domain}?`))) throw new CliError("Aborted.");
            }

            const result = await syncForwarders(c, desired as Record<string, string>, {
                prune: options.prune,
                keep: options.keep,
                existing,
                onChange: (op, f, error) => error && log(`! failed to ${op} ${f.alias} -> ${f.forwardTo}: ${error}`),
            });
            return { ...result, plan };
        });

        if (opts.json) {
            const { plan, ...rest } = summary;
            console.log(JSON.stringify(options.dryRun ? { dryRun: true, ...plan } : rest, null, 2));
        } else if (!options.dryRun && (summary.added.length || summary.removed.length || summary.errors.length)) {
            log(`Done: ${summary.added.length} added, ${summary.removed.length} removed, ${summary.errors.length} failed.`);
        }
        if (summary.errors.length > 0) process.exitCode = EXIT_PARTIAL;
    });

program
    .command("serve")
    .description("run a local headless browser server for StealthNamecheapClient (set NAMECHEAP_BROWSER_WS to its URL)")
    .option("--port <port>", "port (0 chooses an available port)", "3000")
    .option("--host <host>", "interface to bind (keep 127.0.0.1 unless it's behind auth)", "127.0.0.1")
    .action(async (options: { port: string; host: string }, cmd: Command) => {
        const server = await startBrowserServer({ port: Number(options.port), host: options.host });
        if (globals(cmd).json) console.log(JSON.stringify({ wsEndpoint: server.wsEndpoint() }));
        else log(`Browser server listening. Use:\n  NAMECHEAP_BROWSER_WS=${server.wsEndpoint()}`);
        const stop = () => server.close().finally(() => process.exit(0));
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf-8");
}

export async function run(argv = process.argv): Promise<void> {
    try {
        await program.parseAsync(argv);
    } catch (error) {
        if (error instanceof CommanderError) {
            process.exitCode = error.exitCode;
            if (error.exitCode && argv.includes("--json")) console.log(JSON.stringify({ ok: false, error: { code: "INVALID_ARGUMENT", message: error.message } }));
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const exitCode = error instanceof SessionExpiredError ? EXIT_AUTH : error instanceof CliError ? error.exitCode : message === "Login cancelled." ? 130 : EXIT_ERROR;
        const code = error instanceof NamecheapError ? error.code : error instanceof CliError ? "INVALID_ARGUMENT" : exitCode === 130 ? "CANCELLED" : "ERROR";
        log(message);
        if (argv.includes("--json")) console.log(JSON.stringify({ ok: false, error: { code, message } }));
        process.exitCode = exitCode;
    }
}
