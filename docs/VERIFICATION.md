# Verification

## Local coverage

Tests cover RFC 6238 vectors, PNG/JPEG authenticator setup, login prompts and saved credential defaults, account/profile separation, TOTP vs device/email challenges, malformed stored secrets, atomic file permissions, redirect bounds, cookie domain/path/expiry selection and persistence, parsing/rejection handling, failed replacement safety, and operation-level browser fallback. Account discovery tests cover metadata validation, pagination progress, ambiguous selection, explicit/environment/default precedence and local selection clearing. The fake server exercises the compiled CLI's JSON output, exit codes, dry runs, pruning confirmation, domains and mutation readback.

## Live checks on September 30, 2026

With the account owner's authorization:

- Fresh headless login used saved username/password and generated a TOTP automatically.
- Cached default login validated the saved session without Chromium startup (one local observation: about 0.74 seconds; this is not a latency guarantee).
- The list response parsed correctly through both the HTTP and browser clients. The compiled CLI also verified cached login and JSON add/list/remove with cleanup.
- Add, duplicate add, multiple destinations on an alias, one-destination deletion, batch deletion, no-prune dry run and no-prune sync were verified by readback.
- HTTP account discovery returned all three account domains. Forward listing succeeded on each domain; mutations were restricted to the account owner's designated test domain.
- Compiled CLI `domains` (filtered/JSON/table), `use`, `use --clear`, account/domain `status` and `check`, human/JSON `list`/`ls`, add, duplicate add and specific/all-destination `remove`/`rm`/`delete` passed.
- Compiled CLI sync from file and stdin, dry-run, no-prune, keep, and confirmed pruning passed with readback. Original forwarding pairs were included in the pruning input; only temporary test aliases were removed.
- `serve --port 0 --json` started installed Chrome; a client connected to its WebSocket endpoint, listed forwards and shut down cleanly. Browser fallback domain discovery also returned the same three domains.
- Both logout modes passed in an isolated temporary profile. The real saved credentials were retained. Help for all commands and aliases rendered successfully.
- Fresh headless saved-credential/TOTP login was repeated after the final credential fallback changes. Cleared selection with an empty domain environment variable reported `domain: null`.
- All temporary test aliases were removed. The initial five-forward baseline was restored exactly by alias/destination pairs.
- Live mutations exposed the distinction between the login CSRF cookie and the domain hidden token, and the need to retain rotated anti-forgery cookies. Regression fixtures now exercise both.

## Limits

These checks establish dashboard state, not delivery of email. Login and mutation behavior may differ on other accounts or when Namecheap/Cloudflare changes its dashboard. Email/device challenges, CAPTCHA, rejected credentials and revoked authenticator setup can still require manual input or `ncf login --browser`. Browserless service connections and serverless browser launch adapters require verification in their own deployment environment. The numbered terminal picker, interactive prune confirmation, manual email/device codes and CAPTCHA were not exercised against the live account. Their local coverage does not establish provider behavior.
