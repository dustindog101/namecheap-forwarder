# Architecture

```
 CLI (src/cli.ts)                     your code
        │                                 │
        └────────────┬────────────────────┘
                     ▼
     NamecheapClient ── plain fetch, no browser startup, serverless-safe
     StealthNamecheapClient ── same calls from inside a Chromium page (Cloudflare fallback)
                     │   both run requests through a RequestQueue: serial, spaced, retry on 429/5xx
                     ▼
     parse.ts ── turns every response into data or a typed error
                     ▼
     ap.www.namecheap.com internal dashboard endpoints
```

| Module | Role |
| :--- | :--- |
| `client.ts` | Direct HTTP client. Sends session cookies and the `ncCompliance` CSRF header. Uses `redirect: "manual"` so an expired session (302 to login) is detected rather than followed. |
| `stealth-client.ts` | Opens the domain control panel in Chromium (launched, or connected to via `NAMECHEAP_BROWSER_WS`) and runs `fetch` from the page. `exportSession()` returns refreshed cookies. |
| `domains.ts` / `settings.ts` | Validated account domain pagination, exact/unique selection, profile-scoped default domain storage. |
| `parse.ts` | Parses the forwarder list (JSON, JSON-in-string, `nc_state`, or HTML attributes) and mutation results. Never returns an empty list for a page it doesn't understand. |
| `sync.ts` | `planSync()` diffs current vs. desired forwards as (alias, destination) pairs. `syncForwarders()` applies adds first, then removals. |
| `login.ts` | Login orchestration: validate a saved session with bounded same-origin redirects, reuse credentials, prompt privately when needed, persist only successful login. |
| `login-profile.ts` / `private-store.ts` | Per-profile login secrets, shape validation, atomic owner-only writes, explicit deletion. |
| `cookie-jar.ts` | Cookie host/path/expiry selection, rotation and browser state round trips. |
| `totp.ts` | RFC 6238 code generation and optional lazy PNG/JPEG QR import. |
| `session-manager.ts` | Saves and loads per-profile sessions (`0600` files) and runs the browser login. |
| `helpers.ts` | Validation, CSRF extraction, `RequestQueue`. |
| `playwright.ts` | Lazy Playwright loading, so importing the SDK doesn't pull in a browser driver. |

## Error model

Methods resolve with data or throw one of these:

- `SessionExpiredError`: the session needs a new login.
- `CloudflareBlockedError`: the request was challenged or rate-limited, after retries.
- `NamecheapApiError`: Namecheap rejected the request, or the response was unrecognizable.

`null` is never returned to mean failure.
