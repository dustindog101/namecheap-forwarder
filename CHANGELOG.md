# Changelog

## Unreleased

- Headless terminal login by default, validated session reuse without browser startup, automatic saved credential login and private prompts on first use.
- Optional RFC 6238 TOTP setup from Base32, otpauth URI or PNG/JPEG QR image; manual codes remain available for device/email challenges.
- Profile-scoped owner-only atomic storage. Logout clears sessions and login secrets by default; `--session-only` preserves login secrets.
- HTTP account domain discovery with bounded pagination, filtered lists, a numbered terminal picker and per-profile default selection.
- Local browser server uses installed Chrome or bundled Chromium, validates ports and supports JSON startup output.
- Typed rejection/authentication errors, JSON CLI errors and explicit exit codes. Rejected HTTP 200 responses no longer look like successful changes.
- HTTP cookie jar, retained cookie rotation and bounded recovery of the domain dashboard mutation token.
- Operation-level browser fallback and one unattended credential recovery attempt per command.
- Pair-based sync, dry run, no-prune and keep options. Adds precede removals; a failed replacement protects the original destination.
- Local fake-server CLI coverage, authenticator fixtures, clean-install checks and live dashboard readback verification.

### Compatibility

The minimum runtime is Node 20.19 (20.x) or Node 22.12 and newer. Playwright remains lazy and is a peer dependency. SDK calls now throw typed errors instead of returning null. Existing session files remain supported, and profiles default to `default`. Login secrets are saved by default; use `--no-save-credentials` for ephemeral login. Release versioning and publishing remain separate maintainer decisions.
