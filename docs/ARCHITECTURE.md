# Architecture & Design

`namecheap-forwarder` is built with a dual-engine architecture designed for maximum performance, minimal footprint, and zero-configuration resilience against anti-bot challenges.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Interface                       │
│             (CLI Commands & TypeScript Library)             │
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
   [ Direct HTTP Engine ]               [ Stealth Browser Engine ]
   • Class: NamecheapClient             • Class: StealthNamecheapClient
   • Runtime: Native fetch              • Runtime: Playwright / CDP
   • Latency: ~100-300ms                • Latency: ~1-3s
   • Best for: Lambdas, Cron, Webhooks  • Best for: Cloudflare Bypass
            │                                     │
            └──────────────────┬──────────────────┘
                               │
                               ▼
               [ Session & Storage Manager ]
               • .session.json (Cookies + CSRF)
               • .auth-state.json (Playwright context)
               • TOTP autofill for the /twofa/totp/ gate
                (falls back to a terminal code prompt)
                               │
                               ▼
                [ Namecheap Internal REST API ]
```

---

## Key Components

### 1. Direct HTTP Engine (`NamecheapClient`)
- Executes standard HTTP `POST` and `GET` requests directly against `ap.www.namecheap.com`.
- Injects standard macOS / Chrome user-agent headers, CSRF headers (`ncCompliance`, `_nccompliance`), and authenticated cookie strings.
- Blazing fast and runs in standard Node.js, Next.js, and serverless environments without spawning browser binaries.

### 2. Stealth Browser Engine (`StealthNamecheapClient`)
- Spawns Playwright or connects via CDP WebSocket to a persistent remote browser (`NAMECHEAP_BROWSER_WS`).
- Evaluates `fetch` calls directly inside the browser's DOM context with full session state.
- Automatically handles Cloudflare JavaScript challenges and WAF verification.

### 3. Declarative Sync Engine (`syncForwarders`)
- Computes a state diff between current forwards reported by Namecheap and desired forwards declared in a JSON map or database.
- Adds missing forwards and deletes obsolete rules with rate-limiting pauses.

### 4. Session Manager (`SessionManager`)
- Automates login flow, captures session cookies and `storageState`.
- Always starts from a **clean browser context**. Reusing a previously captured `storageState` restores the old session, which makes Namecheap skip the sign-in form and leaves the credential step with nothing to fill.
- Falls back to a terminal code prompt when no TOTP seed is available.

### 5. TOTP Provider (`totp.ts` + `totp-store.ts`)
- `totp.ts` is a dependency-free RFC 6238 implementation (HMAC-SHA1, 6 digits, 30s) on `node:crypto`. A ~60-line primitive does not warrant an npm dependency.
- `totp-store.ts` resolves the seed in precedence order: `NAMECHEAP_TOTP_SECRET` → `./<domain>.totp` (mode `0600`) → none.
- A seed plus `NAMECHEAP_USERNAME`/`NAMECHEAP_PASSWORD` is what allows `login` to run fully headless with no human in the loop.

---

## The 2FA Gate — `/twofa/totp/`

Namecheap's authenticator gate is a single form, and three details make it easy to get wrong:

| Detail | Value | Why it matters |
| :--- | :--- | :--- |
| Code field | `<input type="tel" placeholder="Enter OTP Code">` | Unnamed and `type="tel"`, so `input[type="text"]` does **not** match it. |
| Submit control | `form.gb-totp-form > button[type="submit"]` | The page's first `button[type="submit"]` is the header's "Sign in" nav control, which does not submit this form. Always scope to the form. |
| Submission | JavaScript, no native form post | The input carries no `name`, so a rejection may re-render the form in place **without any URL change**. |

Because the rejection path may not change the URL, acceptance is inferred from the gate
*disappearing* (observed twice in a row) rather than from navigation alone.

### Code-submission flow

```
generate TOTP
   │
   ├─ validForSeconds < 10 ? ──► wait for the next window, regenerate
   │
   ▼
fill <form.gb-totp-form> input[type=tel]  ──►  click that form's own Submit
   │
   ▼
poll up to 20s: gate gone twice in a row ? ──yes──► accepted
   │                                            └─no───► rejected
   ▼
rejected and attempts left ? ──► wait out the window, regenerate, submit again (max 2 attempts)
```

Codes are never logged — only the seed mask (`••••••••ECHX`) and the remaining validity.
The 2-attempt cap exists because rejected codes are rate-limited upstream.

