#!/usr/bin/env node

import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { 
    SessionManager, 
    StealthNamecheapClient, 
    NamecheapClient, 
    syncForwarders,
    startBrowserServer
} from "../dist/index.js";

const program = new Command();

program
    .name("namecheap-forwarder")
    .description("⚡ Unofficial Namecheap Email Forwarding API & CLI tool")
    .version("1.0.0");

function resolveDomain(cmdDomain) {
    const domain = cmdDomain || process.env.NAMECHEAP_DOMAIN || process.env.DOMAIN;
    if (!domain) {
        console.error("❌ Error: Domain is required. Provide -d <domain> or set NAMECHEAP_DOMAIN in your environment.");
        process.exit(1);
    }
    return domain.trim().toLowerCase();
}

async function getClient(domain, stealth = false) {
    const manager = new SessionManager(process.env.NAMECHEAP_SESSION_DIR || process.cwd());
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

program.command("login")
    .description("Interactive Playwright login to capture authentication cookies and CSRF tokens")
    .option("-d, --domain <domain>", "Domain to associate session with (e.g. example.com)")
    .option("--headless", "Attempt headless login with NAMECHEAP_USERNAME and NAMECHEAP_PASSWORD", false)
    .action(async (options) => {
        const domain = resolveDomain(options.domain);
        const manager = new SessionManager(process.env.NAMECHEAP_SESSION_DIR || process.cwd());
        try {
            console.log(`🔐 Starting login flow for domain: ${domain}...`);
            await manager.interactiveLogin(domain, {
                username: process.env.NAMECHEAP_USERNAME,
                password: process.env.NAMECHEAP_PASSWORD,
                headless: Boolean(options.headless)
            });
            console.log(`\n✅ Session captured and saved to ./${domain}.session.json`);
            console.log(`💡 You can now run 'namecheap-forwarder list -d ${domain}'`);
        } catch (err) {
            console.error(`\n❌ Login failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program.command("list")
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
                console.table(forwards.map(f => ({
                    "Email Alias": `${f.alias}@${domain}`,
                    "Forward To": f.forwardTo,
                    "Mailbox ID": f.mailboxId ?? "N/A"
                })));
            }
        } catch (err) {
            if (client.close) await client.close();
            console.error(`❌ Failed to list forwarders: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

program.command("add")
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

program.command("delete")
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
                const match = existing?.find(f => f.alias.toLowerCase() === alias.toLowerCase());
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

program.command("check")
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

program.command("sync")
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
            console.log(`   ➕ Added (${summary.added.length}):`, summary.added.map(a => `${a.alias} ➔ ${a.forwardTo}`));
            console.log(`   🗑️ Removed (${summary.removed.length}):`, summary.removed.map(r => `${r.alias} ➔ ${r.forwardTo}`));
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

program.command("serve")
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
