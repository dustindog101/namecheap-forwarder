<div align="center">

# ⚡ Namecheap Forwarder ⚡

**Unofficial Namecheap Email Forwarding API, TypeScript SDK & CLI**

*Bypass Namecheap's $50 account balance / 20-domain API paywall with automated session authentication and reverse-engineered internal REST endpoints.*

<br/>

[![npm version](https://img.shields.io/npm/v/namecheap-forwarder.svg?style=flat-square&color=339933)](https://www.npmjs.com/package/namecheap-forwarder)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Playwright](https://img.shields.io/badge/Playwright-Automated_Auth-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://playwright.dev/)
[![Vitest](https://img.shields.io/badge/Tested%20with-Vitest-FCC72B?style=flat-square&logo=vitest&logoColor=black)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/dustindog101/namecheap-forwarder/pulls)

</div>

---

## 🎯 The Problem vs The Solution

| The Namecheap Problem 🛑 | The Namecheap Forwarder Solution ⚡ |
| :--- | :--- |
| **$50 Balance Requirement**: Namecheap restricts their official XML API to accounts with $50+ balance or 20+ domains. | **$0 Cost**: Zero requirements. Works with any standard Namecheap account holding 1 or more domains. |
| **Expensive Email Providers**: Setting up dynamic aliases with Google Workspace, Fastmail, or Resend adds monthly bills. | **100 Free Forwards**: Leverages Namecheap's built-in 100 free email forwards per domain. |
| **Manual Web Dashboard**: Adding aliases manually in the control panel is slow and un-automatable. | **CLI + TypeScript SDK**: Full programmatic automation for scripts, cron jobs, and Next.js / Node.js webhooks. |

---

## 🌟 Key Features

- 🚀 **Zero-API-Key Automation**: Authenticates using real browser session tokens and automated 2FA/device verification handling.
- ⚡ **Dual-Engine Architecture**:
  - **Direct HTTP Engine (`NamecheapClient`)**: Blazing fast sub-second execution using cached cookies and CSRF tokens.
  - **Stealth Browser Engine (`StealthNamecheapClient`)**: Headless Playwright client that navigates inside a real browser context to bypass Cloudflare challenges.
- 🛠️ **Full Interactive CLI (`ncf` / `namecheap-forwarder`)**:
  - `login` — Interactive or headless authentication with terminal 2FA prompt.
  - `list` — View active forwards in formatted tables or JSON.
  - `add` — Add new forwarding rules (including catch-all `*`).
  - `delete` — Remove existing forwarding rules.
  - `check` — Test session validity and token freshness.
  - `sync` — Declarative batch synchronization from a JSON configuration.
  - `serve` — Launch a local CDP WebSocket browser server for shared headless sessions.
- 📦 **TypeScript First**: Full typings, ESM exports, and clean async interfaces.
- 🔒 **Security Minded**: Automatically caches sessions to gitignored local files (`.session.json` and `.auth-state.json`).

---

## 🏗️ Architecture & Session Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    namecheap-forwarder                      │
└─────────────────────────────────────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
   [ Session Manager ]                    [ CLI / SDK Core ]
  • Playwright Browser                   • NamecheapClient (Direct HTTP)
  • TOTP autofill (or code prompt)       • StealthNamecheapClient (Browser/CDP)
  • Cookie & CSRF Capture                • Declarative Sync Engine
            │                                     │
            ▼                                     ▼
 ┌──────────────────────┐              ┌──────────────────────┐
 │   .session.json      │ ───────────► │ Namecheap Internal   │
 │   .auth-state.json   │              │ Dashboard REST APIs  │
 │   <domain>.totp      │              │ • /AddForwarder      │
 └──────────────────────┘              │ • /DeleteForwarder   │
                                       │ • /GetDomainDetails  │
                                       └──────────────────────┘
```

---

## 🚀 Quick Start (2 Minutes)

### 1. Installation

```bash
# Global CLI install
npm install -g namecheap-forwarder

# Or local project dependency
npm install namecheap-forwarder
```

### 2. Login to Capture Session

```bash
ncf login -d yourdomain.com
```

> **What happens:**
> 1. A browser window opens to the Namecheap login page.
> 2. Your username and password are filled in from `NAMECHEAP_USERNAME` / `NAMECHEAP_PASSWORD`, or you type them in.
> 3. If a TOTP authenticator seed is configured, the 2FA code is generated and submitted automatically. Otherwise you are prompted for it in the terminal.
> 4. Your auth cookies and CSRF compliance tokens are saved securely to `./yourdomain.com.session.json`.

### 2a. Fully Unattended Login (optional)

If `NAMECHEAP_USERNAME`, `NAMECHEAP_PASSWORD` **and** a TOTP seed are all available,
`ncf login` runs headless with no human in the loop — suitable for CI and cron:

```bash
# One-time: store the seed from your authenticator app (per-domain file, mode 0600)
ncf 2fa:setup -d yourdomain.com

# Confirm it matches your phone before trusting it
ncf 2fa:code -d yourdomain.com

# From now on this needs no interaction at all
NAMECHEAP_USERNAME=me NAMECHEAP_PASSWORD=secret ncf login -d yourdomain.com
```

### 3. Add an Email Forward

```bash
ncf add support yourpersonal@gmail.com -d yourdomain.com
```

### 4. List Active Forwarders

```bash
ncf list -d yourdomain.com
```

**Output:**
```text
📋 Active Forwarders on yourdomain.com (2 total):
┌─────────┬─────────────────────────┬──────────────────────────┬────────────┐
│ (index) │ Email Alias             │ Forward To               │ Mailbox ID │
├─────────┼─────────────────────────┼──────────────────────────┼────────────┤
│ 0       │ 'support@yourdomain.com'│ 'yourpersonal@gmail.com' │ 1849201    │
│ 1       │ '*@yourdomain.com'      │ 'yourpersonal@gmail.com' │ 1849202    │
└─────────┴─────────────────────────┴──────────────────────────┴────────────┘
```

---

## 🛠️ CLI Command Reference

Both `namecheap-forwarder` and `ncf` are available as CLI aliases.

### `ncf login`
Authenticate and save session cookies + CSRF tokens.
```bash
# Interactive headed browser (recommended for first time)
ncf login -d example.com

# Headless with environment variables
NAMECHEAP_USERNAME=myuser NAMECHEAP_PASSWORD=mypass ncf login -d example.com --headless

# Headless + automatic TOTP (no interaction at all)
ncf 2fa:setup -d example.com
NAMECHEAP_USERNAME=myuser NAMECHEAP_PASSWORD=mypass ncf login -d example.com

# Force a visible browser (e.g. for a 2FA method this tool does not automate)
ncf login -d example.com --headed
```

Headless is selected automatically when `NAMECHEAP_USERNAME`, `NAMECHEAP_PASSWORD` and a
TOTP seed are all present. `--headless` forces it; `--headed` forces a visible window.

### `ncf 2fa:setup` / `2fa:code` / `2fa:status` / `2fa:remove`
Manage the TOTP seed used to clear Namecheap's 2FA gate automatically.
```bash
# Store the seed from your authenticator app (hidden input, saved mode 0600)
ncf 2fa:setup -d example.com

# Compare the generated code with your phone to prove the seed is right
ncf 2fa:code -d example.com

ncf 2fa:status -d example.com
ncf 2fa:remove -d example.com
```

The seed can also come from the `NAMECHEAP_TOTP_SECRET` environment variable, which takes
precedence over the per-domain file. Precedence order:

1. `NAMECHEAP_TOTP_SECRET` — for CI / one-off automation
2. `./<domain>.totp` — written by `ncf 2fa:setup`, permissions `0600`
3. Neither — you are prompted for the code when the gate appears

### `ncf list`
List all forwarding rules for a domain.
```bash
# Pretty table output
ncf list -d example.com

# Formatted JSON output
ncf list -d example.com --json

# Run through Stealth Playwright client (if Cloudflare challenge is active)
ncf list -d example.com --stealth
```

### `ncf add <alias> <destination>`
Add a new email forward.
```bash
# Regular alias (e.g. hello@example.com -> inbox@gmail.com)
ncf add hello inbox@gmail.com -d example.com

# Catch-all alias (*@example.com -> inbox@gmail.com)
ncf add "*" inbox@gmail.com -d example.com
```

### `ncf delete <alias> [destination]`
Remove an email forward rule.
```bash
ncf delete hello -d example.com
```

### `ncf check`
Verify if the stored session is still valid.
```bash
ncf check -d example.com
```

### `ncf sync <configFile>`
Declaratively synchronize forwarding rules from a JSON file. Missing rules are created, obsolete rules are deleted.
```bash
# Dry run (preview changes without applying)
ncf sync forwards.json -d example.com --dry-run

# Apply sync
ncf sync forwards.json -d example.com
```

### `ncf serve`
Start a persistent headless Chrome CDP server on WebSocket.
```bash
ncf serve --port 3000
```

---

## 💻 TypeScript / Node.js SDK

You can integrate `namecheap-forwarder` directly into your Node.js, Next.js, Express, or Fastify backends.

### 1. Direct HTTP Client (`NamecheapClient`)

Ultra-fast execution for serverless functions, background workers, and webhooks:

```typescript
import { NamecheapClient, SessionManager } from "namecheap-forwarder";

// 1. Load session from disk (or from database / environment variables)
const manager = new SessionManager("./sessions");
const session = await manager.loadSession("example.com");

if (!session) {
    throw new Error("No session found. Run ncf login first.");
}

// 2. Initialize client
const client = new NamecheapClient(session, "example.com");

// 3. List forwards
const forwards = await client.listForwarders();
console.log("Current forwards:", forwards);

// 4. Add forward
await client.addForwarder("billing", "accounting@mycompany.com");

// 5. Delete forward
await client.deleteForwarder("oldalias", "accounting@mycompany.com");
```

### 2. Stealth Browser Client (`StealthNamecheapClient`)

Use when running in environments prone to Cloudflare bot verification or connecting to a remote CDP browser (e.g., Browserless, Camoufox, or local `ncf serve`):

```typescript
import { StealthNamecheapClient, SessionManager } from "namecheap-forwarder";

const manager = new SessionManager();
const session = await manager.loadSession("example.com");

const client = new StealthNamecheapClient(
    session!,
    "example.com",
    process.env.NAMECHEAP_BROWSER_WS // e.g. "ws://localhost:3000" or Browserless
);

try {
    const forwards = await client.listForwarders();
    console.log(forwards);
} finally {
    await client.close();
}
```

### 3. Declarative Batch Sync in Code

```typescript
import { NamecheapClient, syncForwarders, SessionManager } from "namecheap-forwarder";

const manager = new SessionManager();
const session = await manager.loadSession("example.com");
const client = new NamecheapClient(session!, "example.com");

// Desired state mapping (alias -> destination)
const desiredForwards = {
    "support": "team@gmail.com",
    "sales": "sales@gmail.com",
    "alerts": "ops@gmail.com",
    "*": "fallback@gmail.com" // Catch-all
};

const summary = await syncForwarders(client, desiredForwards);
console.log("Added:", summary.added);
console.log("Removed:", summary.removed);
console.log("Errors:", summary.errors);
```

### 4. Next.js / Server Action Dynamic Alias Creation

```typescript
// app/actions/create-alias.ts
"use server";

import { NamecheapClient } from "namecheap-forwarder";

export async function createEmailAlias(alias: string, destination: string) {
    const session = {
        cookies: process.env.NAMECHEAP_SESSION_COOKIES!,
        csrfToken: process.env.NAMECHEAP_NCCOMPLIANCE_TOKEN!
    };

    const client = new NamecheapClient(session, process.env.NAMECHEAP_DOMAIN || "example.com");
    return client.addForwarder(alias, destination);
}
```

---

## 📁 Declarative Config Format (`forwards.json`)

Define your desired alias routing in a clean JSON key-value format:

```json
{
  "support": "help@company.com",
  "billing": "finance@company.com",
  "founder": "ceo@personal.com",
  "*": "catchall@company.com"
}
```

Run sync:
```bash
ncf sync forwards.json -d mydomain.com
```

---

## ⚙️ Configuration & Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `NAMECHEAP_DOMAIN` | Target domain name | `undefined` |
| `NAMECHEAP_SESSION_DIR` | Directory where `*.session.json` is stored | Current working directory |
| `NAMECHEAP_SESSION_COOKIES` | Raw cookie string for stateless/serverless direct client | `undefined` |
| `NAMECHEAP_NCCOMPLIANCE_TOKEN` | CSRF compliance header token | `undefined` |
| `NAMECHEAP_USERNAME` | Namecheap username for auto-login | `undefined` |
| `NAMECHEAP_PASSWORD` | Namecheap password for auto-login | `undefined` |
| `NAMECHEAP_TOTP_SECRET` | Base32 authenticator seed; enables unattended 2FA | `undefined` |
| `NAMECHEAP_BROWSER_WS` | WebSocket endpoint for remote CDP browser server | `undefined` |

---

## 🔧 Troubleshooting Matrix

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| **`HTTP 401 Unauthorized`** | Session cookies expired | Run `ncf login -d <domain>` to refresh the session tokens. |
| **`HTTP 403 Forbidden`** | Missing or incorrect CSRF token | Ensure `ncCompliance` / `_nccompliance` token is present in `.session.json`. Re-run `ncf login`. |
| **`CLOUDFLARE_BLOCKED`** | Cloudflare bot protection triggered on direct HTTP calls | Use the `--stealth` flag or `StealthNamecheapClient` to route requests through a real browser. |
| **Device Verification Prompt** | Namecheap flagged new login IP / device | Enter the verification code in your terminal when prompted by `ncf login`. |
| **`Namecheap API error: A required anti-forgery token …`** | The wrong CSRF token is cached in `.session.json` (Namecheap issues two) | Re-run `ncf login -d <domain>` to re-capture the session; `resolveCsrfToken` must pick the `_NcCompliance` GUID, not `x-ncpl-csrf`. |
| **`Namecheap API error: This Email Forwarder already exists`** | `add` was run for an alias that already exists | Use `ncf delete` first, or pick a different alias. |
| **`Namecheap rejected the TOTP code twice`** | Stored seed or device clock is wrong | Run `ncf 2fa:code -d <domain>` and compare with your authenticator app. If they differ, re-seed with `ncf 2fa:setup`. Check your system clock is NTP-synced. |
| **`Namecheap requires a TOTP code but no seed is configured`** | Headless login with no seed available | Run `ncf 2fa:setup -d <domain>`, or drop `--headless` to type the code. |
| **`Headless login needs NAMECHEAP_USERNAME and NAMECHEAP_PASSWORD`** | Credentials not exported | Export both variables, or drop `--headless`. |
| **Forward limit reached** | Exceeded Namecheap's 100 free forwarder limit | Delete obsolete forwarders or use a catch-all `*` forwarder. |

---

## 📚 Reverse-Engineered Internal API

For a full reference on the underlying HTTP endpoints, headers, payloads, and response parsing, see:
👉 [docs/NAMECHEAP_INTERNAL_API.md](docs/NAMECHEAP_INTERNAL_API.md)

---

## 🔒 Security & Best Practices

1. **Never commit `.session.json` or `.auth-state.json`**: These files contain full authentication cookies to your Namecheap account. They are included in `.gitignore` by default.
2. **Treat the TOTP seed like a password**: `<domain>.totp` and `NAMECHEAP_TOTP_SECRET` grant indefinite access to your account's 2FA-protected surface — anyone who reads the seed can mint valid codes forever, no password required. `ncf 2fa:setup` writes it with mode `0600` and it is git-ignored, but prefer a secrets manager for CI. Rotate the seed in Namecheap's 2FA settings if it is ever exposed.
3. **Use Dedicated Machine/Secrets Manager**: If running in CI/CD or serverless environments, store `NAMECHEAP_SESSION_COOKIES` and `NAMECHEAP_NCCOMPLIANCE_TOKEN` as encrypted environment secrets.
4. **Session Lifespan**: Namecheap web sessions typically last between **1 to 3 weeks** before needing a refresh.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!
Feel free to check the [issues page](https://github.com/dustindog101/namecheap-forwarder/issues).

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for more information.

<div align="center">
Made with ❤️ by <a href="https://github.com/dustindog101">dustindog101</a>
</div>
