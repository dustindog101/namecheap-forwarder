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
               • Interactive & Headless Auth with 2FA
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
- Provides terminal-interactive 2FA prompts when Namecheap requests device verification codes.
