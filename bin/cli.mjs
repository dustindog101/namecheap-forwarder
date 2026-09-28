#!/usr/bin/env node

import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
    SessionManager,
    StealthNamecheapClient,
    NamecheapClient,
    syncForwarders,
    startBrowserServer,
    resolveTotpSecret,
    saveTotpSecret,
    removeTotpSecret,
    generateTotp,
    isValidSecret,
    maskSecret,
    TOTP_ENV_VAR,
} from "../dist/index.js";

const program = new Command();

program
    .name("namecheap-forwarder")
    .description("⚡ Unofficial Namecheap Email Forwarding API & CLI tool")
    .version("1.0.0");

function sessionDir() {
    return process.env.NAMECHEAP_SESSION_DIR || process.cwd();
}

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);

/** Reads a value without echoing it, so a TOTP seed never lands in terminal history or scrollback. */
function promptSecret(question) {
    if (!process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise((resolve) =>
            rl.question(question, (answer) => {
                rl.close();
                resolve(answer.trim());
            }),
        );
    }

    return new Promise((resolve) => {
        process.stdout.write(question);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");

        let value = "";
        const cleanup = () => {
            process.stdin.off("data", onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write("\n");
        };
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === "\r" || ch === "\n") {
                    cleanup();
                    resolve(value.trim());
                    return;
                }
                if (ch === CTRL_C) {
                    cleanup();
                    process.exit(130);
                }
                if (ch === BACKSPACE || ch === "\b") {
                    value = value.slice(0, -1);
                    continue;
                }
                value += ch;
            }
        };
        process.stdin.on("data", onData);
    });
}

function resolveDomain(cmdDomain) {
    const domain = cmdDomain || process.env.NAMECHEAP_DOMAIN || process.env.DOMAIN;
    if (!domain) {
        console.error("❌ Error: Domain is required. Provide -d <domain> or set NAMECHEAP_DOMAIN in your environment.");
        process.exit(1);
    }
    return domain.trim().toLowerCase();
}

async function getClient(domain, stealth = false) {
    const manager = new SessionManager(sessionDir());
    const session = await manager.loadSession(domain);
    if (!session) {
        console.error(`❌ No session found for ${domain}. Run 'namecheap-forwarder login -d ${domain}' first.`);
        process.exit(1);
    }
    if (stealth) {
        return new StealthNamecheapClient(session, domain, process.env.NAMECHEAP_BROWSER_WS);
    }
    return new NamecheapClient(session, domain);
}

program
    .command("2fa")
    .description("Manage the TOTP seed used to clear Namecheap's 2FA gate non-interactively");

program
    .command("2fa:setup")
    .description("Store the authenticator seed for a domain (enables fully unattended login)"
    )
    .option("-d, --domain <domain>", "Domain to associate the seed with")
    .option("-s, --secret <secret>", "Seed value (prefer the prompt; this lands in shell history)")
    .action(async (options) => {
        const domain = resolveDomain(options.domain);
        const dir = sessionDir();

        let secret = options.secret || process.env[TOTP_ENV_VAR];
        if (!secret) {
            console.log("🧬 Enter the base32 seed from your authenticator app (shown as 'setup key' / manual entry).");
            secret = await promptSecret("   👉 Seed (input hidden): ");
        }

        if (!isValidSecret(secret)) {
            console.error("❌ That is not a valid base32 seed. Expected letters A-Z and digits 2-7, 16-32 characters.");
            process.exit(1);
        }

        try {
            const saved = await saveTotpSecret(domain, secret, dir);
            console.log(`✅ Seed saved for ${domain} (${maskSecret(secret)})`);
            console.log(`   📁 ${saved.path} (permissions 0600)`);
            console.log(`\n💡 Verify it with: namecheap-forwarder 2fa:code -d ${domain}`);
        } catch (err) {
            console.error(`❌ Failed to save seed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program
    .command("2fa:code")
    .description("Print the current TOTP code so you can compare it against your authenticator app"
    )
    .option("-d, --domain <domain>", "Domain whose seed to use")
    .option("-s, --secret <secret>", "Use this seed instead of the stored one")
    .action(async (options) => {
        const domain = resolveDomain(options.domain);
        const resolved = options.secret
            ? { secret: options.secret, source: "flag", location: "--secret" }
            : await resolveTotpSecret(domain, sessionDir());

        if (!resolved) {
            console.error(
                `❌ No TOTP seed configured for ${domain}. Run 'namecheap-forwarder 2fa:setup -d ${domain}' first.`,
            );
            process.exit(1);
        }

        try {
            const totp = generateTotp(resolved.secret);
            console.log(`\n🔐 Current TOTP code for ${domain}: ${totp.code}`);
            console.log(`   Valid for ${totp.validForSeconds}s (source: ${resolved.source}, ${resolved.location})`);
            console.log(`\n💡 If this does not match your app, your seed or device clock is wrong.`);
        } catch (err) {
            console.error(`❌ Could not generate a code: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program
    .command("2fa:status")
    .description("Show whether a TOTP seed is configured, and where it comes from"
    )
    .option("-d, --domain <domain>", "Domain to inspect")
    .action(async (options) => {
        const domain = resolveDomain(options.domain);
        const resolved = await resolveTotpSecret(domain, sessionDir());
        if (!resolved) {
            console.log(`ℹ️  No TOTP seed for ${domain}. Namecheap 2FA will require manual entry.`);
            console.log(`   Set one up with: namecheap-forwarder 2fa:setup -d ${domain}`);
            return;
        }
        console.log(`✅ TOTP seed configured for ${domain} (${maskSecret(resolved.secret)})`);
        console.log(`   Source: ${resolved.source} → ${resolved.location}`);
    });

program
    .command("2fa:remove")
    .description("Delete the stored TOTP seed for a domain"
    )
    .option("-d, --domain <domain>", "Domain to clear")
    .action(async (options) => {
        const domain = resolveDomain(options.domain);
        const removed = await removeTotpSecret(domain, sessionDir());
        console.log(removed ? `🗑️ Removed TOTP seed for ${domain}.` : `ℹ️  No stored seed for ${domain}.`);
    });

program
    .command("login")
    .description("Log in to Namecheap and capture session cookies and CSRF tokens"
    )
    .option("-d, --domain <domain>", "Domain to associate session with (e.g. example.com)")
    .option("--headless", "Force headless (default: automatic when credentials and a TOTP seed are present)")
    .option("--headed", "Force a visible browser, e.g. to complete 2FA by hand")
    .action(async (options) => {
        const domain = resolveDomain(options.domain);
        const manager = new SessionManager(sessionDir());
        try {
            console.log(`🔐 Starting login flow for domain: ${domain}...`);
            await manager.interactiveLogin(domain, {
                username: process.env.NAMECHEAP_USERNAME,
                password: process.env.NAMECHEAP_PASSWORD,
                headless: options.headless,
                headed: options.headed,
            });
            console.log(`\n✅ Session captured and saved to ${path.join(sessionDir(), `${domain}.session.json`)}`);
            console.log(`💡 You can now run 'namecheap-forwarder list -d ${domain}'`);
        } catch (err) {
            console.error(`\n❌ Login failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program
    .command("list")
    .description("List all active email forwarding rules for a domain")
    .option("-d, --domain <domain>", "Domain name")
    .option("--json", "Output results as formatted JSON")
    .option("--stealth", "Use Playwright stealth client to bypass Cloudflare challenges")
    .action(async (options) => {
        const domain = resolveDomain(options.domain);
        const client = await getClient(domain, options.stealth);
        try {
            console.log(`🔍 Fetching email forwarders for ${domain}...`);
            const forwards = await client.listForwarders();
            if (client.close) await client.close();

            if (forwards === null) {
                console.error(`❌ Session is expired or invalid. Please re-run 'namecheap-forwarder login -d ${domain}'.`);
                process.exit(1);
            }

            if (options.json) {
                console.log(JSON.stringify(forwards, null, 2));
            } else if (forwards.length === 0) {
                console.log(`ℹ️ No forwarders found on ${domain}.`);
            } else {
                console.log(`\n📋 Active Forwarders on ${domain} (${forwards.length} total):`);
                console.table(
                    forwards.map((f) => ({
                        "Email Alias": `${f.alias}@${domain}`,
                        "Forward To": f.forwardTo,
                        "Mailbox ID": f.mailboxId ?? "N/A",
                    })),
                );
            }
        } catch (err) {
            if (client.close) await client.close();
            console.error(`❌ Failed to list forwarders: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program
    .command("add")
    .description("Add a new email forwarder rule (e.g. support@domain.com -> inbox@gmail.com)")
    .argument("<alias>", "Mailbox alias prefix (e.g. 'support', 'contact', or '*' for catch-all)")
    .argument("<destination>", "Destination email address")
    .option("-d, --domain <domain>", "Domain name")
    .option("--stealth", "Use stealth client")
    .action(async (alias, destination, options) => {
        const domain = resolveDomain(options.domain);
        const client = await getClient(domain, options.stealth);
        try {
            console.log(`➕ Adding forwarder: ${alias}@${domain} ➔ ${destination}`);
            const result = await client.addForwarder(alias, destination);
            if (client.close) await client.close();

            if (result === null) {
                console.error(`❌ Failed to add forwarder. Session might be expired.`);
                process.exit(1);
            }
            console.log(`✅ Successfully added forwarder: ${alias}@${domain} ➔ ${destination}`);
        } catch (err) {
            if (client.close) await client.close();
            console.error(`❌ Failed to add forwarder: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program
    .command("delete")
    .description("Delete an existing email forwarder rule")
    .argument("<alias>", "Mailbox alias prefix (e.g. 'support')")
    .argument("[destination]", "Destination email address (optional, will search if omitted)")
    .option("-d, --domain <domain>", "Domain name")
    .option("--stealth", "Use stealth client")
    .action(async (alias, destination, options) => {
        const domain = resolveDomain(options.domain);
        const client = await getClient(domain, options.stealth);
        try {
            let dest = destination;
            if (!dest) {
                const existing = await client.listForwarders();
                const match = existing?.find((f) => f.alias.toLowerCase() === alias.toLowerCase());
                if (!match) {
                    console.error(`❌ Could not find an existing forwarder with alias '${alias}@${domain}'.`);
                    if (client.close) await client.close();
                    process.exit(1);
                }
                dest = match.forwardTo;
            }

            console.log(`🗑️ Deleting forwarder: ${alias}@${domain} (➔ ${dest})`);
            const result = await client.deleteForwarder(alias, dest);
            if (client.close) await client.close();

            if (result === null) {
                console.error(`❌ Failed to delete forwarder. Session might be expired.`);
                process.exit(1);
            }
            console.log(`✅ Successfully deleted forwarder: ${alias}@${domain}`);
        } catch (err) {
            if (client.close) await client.close();
            console.error(`❌ Failed to delete forwarder: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program
    .command("check")
    .description("Check if the saved session for a domain is still valid and authenticated")
    .option("-d, --domain <domain>", "Domain name")
    .action(async (options) => {
        const domain = resolveDomain(options.domain);
        const client = await getClient(domain);
        try {
            console.log(`🔍 Checking session validity for ${domain}...`);
            const isValid = await client.isSessionValid();
            if (isValid) {
                console.log(`✅ Session for ${domain} is VALID and ready to use!`);
            } else {
                console.log(`❌ Session for ${domain} is EXPIRED or INVALID. Run 'namecheap-forwarder login -d ${domain}' to refresh.`);
                process.exit(1);
            }
        } catch (err) {
            console.error(`❌ Session check failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program
    .command("sync")
    .description("Declaratively sync forwarders from a JSON file (adds missing, removes obsolete)")
    .argument("<configFile>", "Path to JSON file with { alias: destination } mapping")
    .option("-d, --domain <domain>", "Domain name")
    .option("--dry-run", "Simulate sync without making any live changes")
    .option("--stealth", "Use stealth client")
    .action(async (configFile, options) => {
        const domain = resolveDomain(options.domain);
        const client = await getClient(domain, options.stealth);
        try {
            const raw = await fs.readFile(path.resolve(process.cwd(), configFile), "utf-8");
            const desired = JSON.parse(raw);
            console.log(`🔄 Syncing forwarders for ${domain}${options.dryRun ? " [DRY RUN]" : ""}...`);
            const summary = await syncForwarders(client, desired, options.dryRun);
            if (client.close) await client.close();

            console.log("\n📊 Sync Summary:");
            console.log(`   ➕ Added (${summary.added.length}):`, summary.added.map((a) => `${a.alias} ➔ ${a.forwardTo}`));
            console.log(`   🗑️ Removed (${summary.removed.length}):`, summary.removed.map((r) => `${r.alias} ➔ ${r.forwardTo}`));
            if (summary.errors.length > 0) {
                console.log(`   ⚠️ Errors (${summary.errors.length}):`, summary.errors);
            }
            console.log("\n✅ Sync finished successfully.");
        } catch (err) {
            if (client.close) await client.close();
            console.error(`❌ Sync failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program
    .command("serve")
    .description("Run a persistent local CDP browser WebSocket server for remote connections")
    .option("-p, --port <port>", "Port number", "3000")
    .action(async (options) => {
        try {
            await startBrowserServer(Number(options.port));
        } catch (err) {
            console.error(`❌ Server error: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program.parse(process.argv);
