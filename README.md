# namecheap-forwarder

**Unofficial CLI and TypeScript SDK for Namecheap email forwarding.**

Namecheap's free email forwarding can only be managed from their dashboard. The official API needs a $50 balance or 20+ domains. This tool drives the dashboard's own internal endpoints with your logged-in session, so you can script forwards from a terminal, CI, or your backend.

[![npm](https://img.shields.io/npm/v/namecheap-forwarder.svg)](https://www.npmjs.com/package/namecheap-forwarder)
[![CI](https://github.com/dustindog101/namecheap-forwarder/actions/workflows/ci.yml/badge.svg)](https://github.com/dustindog101/namecheap-forwarder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

```console
$ ncf add support@example.com me@gmail.com
Added   support@example.com -> me@gmail.com

$ ncf ls example.com
ALIAS                FORWARDS TO
-------------------  ------------
support@example.com  me@gmail.com
*@example.com        me@gmail.com
```

> [!WARNING]
> This is not affiliated with Namecheap. It uses undocumented endpoints that can change without notice, and automating your account may conflict with Namecheap's terms of service. Use it on your own account at your own risk.

## Install

```bash
npm install -g namecheap-forwarder
```

Requires Node.js 20.19+ or 22.12+ (including newer LTS releases). Terminal login uses a background browser: your installed Google Chrome is used if present. If you don't have Chrome, run `npx playwright install chromium` once.

## Quick start

```bash
ncf login                                      # terminal login; enter credentials and 2FA
ncf domains                                    # discover domains in the account
ncf use example.com                            # save the default for this profile
ncf add support me@gmail.com                    # forward an alias
ncf ls                                         # see what's configured
ncf rm support                                 # remove it
```

A login covers every domain in your Namecheap account. You don't need to log in per domain. Domain discovery, listing and changes use HTTP; a browser is started for authentication or a Cloudflare fallback.

`ncf use` without an argument opens a numbered terminal picker. Pass a full domain or a unique substring to select directly, for example `ncf use example`. `ncf domains example` filters the list, and `ncf use --clear` clears the selection. Selections belong to the profile, so separate accounts can have separate defaults. An explicit address or positional domain takes precedence, then `-d`, then `NAMECHEAP_DOMAIN`, then the saved selection. Conflicting explicit `-d` and full addresses are rejected.

### Save terminal login and automatic authenticator codes

```bash
ncf login --totp-secret       # private prompts for username, password and setup secret
ncf login --totp-qr /path/to/authenticator.png
ncf login --fresh                               # test login again using saved credentials and TOTP
ncf login --browser                             # manual browser login when needed
```

`--totp-secret` accepts a Base32 setup secret or an `otpauth://totp/` URI. A six-digit code alone cannot generate future codes. QR import accepts an authenticator setup image (PNG/JPEG), not a screenshot of a changing six-digit code. Setup is optional: without a saved secret, the terminal asks for the current code. Email/device verification still asks for a code; automatic TOTP is used only when the page identifies an authenticator challenge. Cloudflare or an additional Namecheap challenge can still require manual browser login.

Credentials are saved by default after successful terminal login (opt out with `--no-save-credentials`), as a per-profile `*.credentials.json` file alongside the session, outside the repository, with mode `0600`. This file contains the password and authenticator secret in plaintext protected by filesystem permissions. `ncf logout` removes both the session and saved login secrets. `ncf logout --session-only` keeps login secrets for automatic login. Secrets are never printed. `NAMECHEAP_TOTP_SECRET` supplies an alternative setup secret through the environment.

## Commands

Both `ncf` and `namecheap-forwarder` work.

| Command | What it does |
| :--- | :--- |
| `ncf login` | Headless login, private prompts on first use, saved credentials on later use. Valid sessions skip browser startup. |
| `ncf logout [--session-only]` | Delete the session and login secrets, or keep secrets with `--session-only`. |
| `ncf status [-d <domain>]` | Check the selected domain or account session and show its age. |
| `ncf domains [filter]` | List every account domain, expiration, auto-renew and selection; optionally filter. |
| `ncf use [domain] [--clear]` | Select a default domain by name, unique substring or terminal picker; clear it with `--clear`. |
| `ncf ls [domain]` | List forwards. |
| `ncf add <address> <dest...>` | Add one or more destinations for an alias. Adding an existing forward is a no-op. |
| `ncf rm <address> [dest...]` | Remove an alias, or only the given destinations. |
| `ncf sync <file> -d <domain>` | Make the domain match a JSON file (see below). |
| `ncf serve` | Run a local headless browser for the stealth client (see [Cloudflare](#cloudflare)). |

**Addresses.** Write `support@example.com`, or `support` after `ncf use example.com` or with `-d example.com`. Use `*` for a catch-all: `ncf add '*@example.com' me@gmail.com`.

**Global options:**

- `-d, --domain`: the domain to manage.
- `-p, --profile`: which saved account to use.
- `--json`: machine-readable output on stdout; progress messages go to stderr.
- `--stealth`: always use a real browser.

**Exit codes:** `0` ok, `1` error, `2` sync finished with some failed changes, `3` login required, `130` cancelled login. With `--json`, errors have `{ "ok": false, "error": { "code", "message" } }` on stdout; progress goes to stderr.

### Declarative sync

Keep your forwards in a file and apply it:

```json
{
  "support": "help@company.com",
  "billing": ["finance@company.com", "ceo@company.com"],
  "*": "catchall@company.com"
}
```

```bash
ncf sync forwards.json -d example.com --dry-run   # show the plan
ncf sync forwards.json -d example.com             # apply it (asks before removing anything)
ncf sync forwards.json -d example.com --yes       # non-interactive / CI
ncf sync forwards.json -d example.com --no-prune  # only add, never remove
ncf sync forwards.json -d example.com --keep '*'  # never remove the catch-all
```

When an alias's destination changes, the new forward is added before the old one is removed. A failed replacement add preserves the old destination and reports a skipped removal. DNS and mail delivery behavior are controlled by Namecheap.

### Multiple accounts

```bash
ncf login --profile work
ncf ls work-domain.com --profile work     # or NAMECHEAP_PROFILE=work
```

## SDK

```ts
import { NamecheapClient, SessionManager, syncForwarders, SessionExpiredError } from "namecheap-forwarder";

const session = await new SessionManager().loadSession(); // saved by `ncf login`
if (!session) throw new Error("Run ncf login first");
const client = new NamecheapClient(session, "example.com");

await client.addForwarder("billing", "accounts@company.com");
console.log(await client.listForwarders()); // [{ alias, forwardTo, mailboxId }]
await client.deleteForwarder("billing", "accounts@company.com");

const summary = await syncForwarders(client, { support: "team@company.com" }, { keep: ["*"] });
```

Every method either succeeds or throws. Namecheap answers HTTP 200 even when it rejects a change, and the client checks the response body for that. The typed errors are:

| Error | Meaning |
| :--- | :--- |
| `SessionExpiredError` | Log in again. Detected from Namecheap's redirect to its login page, so an expired session is never mistaken for "no forwards". |
| `CloudflareBlockedError` | Challenged or rate-limited. The client already retried with backoff before throwing. |
| `NamecheapApiError` | Namecheap rejected the change. `.message` has their reason and `.body` has the raw response. |

For account discovery, use `await new NamecheapClient(session).listDomains()` without a domain. Pass a domain to the constructor for forwarding operations.

The HTTP client keeps a cookie jar, retains rotated cookies, and refreshes the domain dashboard token once after an explicit anti-forgery rejection. Save `client.exportSession()` after a successful batch when using the SDK; the CLI does this automatically.

Adding a forward that already exists succeeds, with `alreadyExisted: true` in the result.

The SDK only loads Playwright when you use `SessionManager.login()` or `StealthNamecheapClient`. `NamecheapClient` is plain `fetch` and works in serverless functions.

If a command finds an expired session, it tries saved credentials once, without terminal prompts. An additional challenge exits 3 with a login hint.

**Sessions without files (CI and serverless).** `SessionManager.fromEnv()` reads `NAMECHEAP_SESSION_COOKIES` and `NAMECHEAP_NCCOMPLIANCE_TOKEN`. The CLI prefers these over the saved file when they're set. Copy the values from `~/.config/namecheap-forwarder/default.session.json`.

## Using it from a web app

Suppose your users create and change their own aliases, as on an alias service. Everything goes through **one Namecheap account and one session**, so plan around that:

1. **Keep your database as the source of truth.** A user action writes to your DB and returns right away. Don't make users wait on Namecheap, which takes about 300 ms per change and occasionally fails.
2. **Apply changes from a single worker.** Queue each change (an outbox table, or a `pending` flag on the alias row) and drain it with one worker, so requests to Namecheap run one at a time. Inside one process, `NamecheapClient` already serializes its calls. Pass a shared `queue: new RequestQueue()` to all clients on the same account. That can't coordinate separate serverless instances, though, which is why the queue belongs in your DB.
3. **Collapse rapid edits.** If a user changes their alias three times before the worker runs, only the latest state matters. Diffing the DB against `listForwarders()` with `planSync()`/`syncForwarders()` does this for you: run it on a schedule or after each batch of changes. It is idempotent and repairs drift.
4. **Treat `SessionExpiredError` as "pause", not "fail".** Leave the jobs queued, alert yourself to run `ncf login`, and resume. Sessions last days, not forever. If you use the stealth client, save `client.exportSession()` after successful runs to keep the session fresh.
5. **Mind the limit.** Namecheap caps forwards per domain (100 at the time of writing). A service with many users will hit that cap. At that scale, use a catch-all forward plus your own routing, such as Cloudflare Email Routing with an Email Worker.

## Cloudflare

Namecheap's dashboard sits behind Cloudflare, which sometimes challenges plain HTTP requests. When that happens the CLI automatically retries the operation inside a headless browser (`StealthNamecheapClient`). It retries the challenged operation and keeps the browser for the rest of the command, so a mid-sync challenge does not replay completed changes. That path is slower, so to avoid starting a new browser every time, keep one running:

```bash
ncf serve                       # prints NAMECHEAP_BROWSER_WS=ws://127.0.0.1:3000/namecheap
ncf serve --port 0 --json        # available port; {"wsEndpoint":"ws://…"} on stdout
export NAMECHEAP_BROWSER_WS=ws://127.0.0.1:3000/namecheap
```

`NAMECHEAP_BROWSER_WS` also accepts a CDP endpoint, such as Browserless or Chrome started with `--remote-debugging-port`.

## Configuration

| Variable | Purpose |
| :--- | :--- |
| `NAMECHEAP_DOMAIN` | Default domain; overrides the saved selection, overridden by an explicit domain/address. |
| `NAMECHEAP_PROFILE` | Default profile for `-p`. |
| `NAMECHEAP_SESSION_DIR` | Where sessions are saved. Default: `~/.config/namecheap-forwarder`. |
| `NAMECHEAP_SESSION_COOKIES`, `NAMECHEAP_NCCOMPLIANCE_TOKEN` | Use this session instead of a saved file. |
| `NAMECHEAP_USERNAME`, `NAMECHEAP_PASSWORD` | Override saved credentials for terminal login. A changed username never reuses another account's password or TOTP. |
| `NAMECHEAP_TOTP_SECRET` | Base32 setup secret or `otpauth://totp/` URI; optional alternative to QR import. |
| `NAMECHEAP_BROWSER_WS` | Remote browser for the stealth client. |
| `NAMECHEAP_STEALTH=1` | Always use the browser client. |

## Security

- A session file is equivalent to being logged in to your Namecheap account, which can transfer or delete domains, not just manage email. Session files are written with owner-only permissions (`0600`) outside your project directory. Don't commit them, and store `NAMECHEAP_SESSION_COOKIES` as a secret.
- `ncf serve` binds to `127.0.0.1`. Anyone who can reach that port controls the browser, so don't expose it without authentication in front.
- Run `ncf logout` when you're done on a shared machine.

## Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| `Not logged in` / exit code 3 | Run `ncf login`. |
| `Blocked by Cloudflare` | The CLI retries in a browser automatically. If it keeps happening, slow down, or use `ncf serve` plus `NAMECHEAP_BROWSER_WS`. |
| `Namecheap rejected the request: …` | Namecheap's reason is included in the message. Common causes: the forward limit, an invalid address, or email forwarding not enabled for the domain (Domain → Mail Settings → Email Forwarding). |
| `Unrecognized forwarders response` | Namecheap probably changed their dashboard. Please [open an issue](https://github.com/dustindog101/namecheap-forwarder/issues). |
| `No browser found` | Install Google Chrome or run `npx playwright install chromium`. |

Keep passwords, session cookies and authenticator secrets out of issue reports. QR images are secrets too.

See [docs/NAMECHEAP_INTERNAL_API.md](docs/NAMECHEAP_INTERNAL_API.md) for the endpoints and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit.

## Development

```bash
npm install
npm run build
npm run lint
npm test        # unit tests + end-to-end tests against a local fake Namecheap server
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for test and release checks, and [docs/VERIFICATION.md](docs/VERIFICATION.md) for the verified behavior and limits.

## License

MIT
