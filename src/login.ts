import { SessionManager } from "./session-manager.js";
import { loadLoginProfile, saveLoginProfile, promptLoginValue } from "./login-profile.js";
import { NamecheapClient } from "./client.js";
import { CloudflareBlockedError, SessionExpiredError } from "./types.js";
import { parseTotp, importTotpQr, type TotpConfig } from "./totp.js";

export type AccountLoginOptions = {
    profile?: string;
    domain?: string;
    browser?: boolean;
    fresh?: boolean;
    saveCredentials?: boolean;
    setupCredentials?: boolean;
    totpSecret?: boolean;
    totpQr?: string;
    /** Disable terminal prompts in automated command recovery. */
    interactive?: boolean;
    env?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
    prompt?: typeof promptLoginValue;
};

/** One login flow for the CLI: saved session -> saved credentials -> private prompts. */
export async function loginAccount(options: AccountLoginOptions = {}, manager = new SessionManager()) {
    const profile = options.profile ?? "default";
    const env = options.env ?? process.env;
    const log = options.log ?? ((message: string) => console.error(message));
    const prompt = options.prompt ?? promptLoginValue;
    const ask = async (label: string, hidden = false) => {
        if (options.interactive === false || (!process.stdin.isTTY && !options.prompt)) {
            throw new SessionExpiredError(`Login needs input. Run: ncf login --profile ${profile}`);
        }
        return prompt(label, hidden);
    };
    if (options.browser && (options.setupCredentials || options.totpSecret || options.totpQr)) throw new Error("Credential setup requires terminal login. Omit --browser.");
    if (options.totpSecret && options.totpQr) throw new Error("Choose --totp-secret or --totp-qr.");
    const saved = options.browser ? null : await loadLoginProfile(manager, profile);
    const accountChanged = !options.browser && Boolean(env.NAMECHEAP_USERNAME && env.NAMECHEAP_USERNAME !== saved?.username);
    let username = options.browser ? undefined : env.NAMECHEAP_USERNAME || saved?.username;
    let password = options.browser ? undefined : env.NAMECHEAP_PASSWORD || (accountChanged ? undefined : saved?.password);
    let totp: TotpConfig | undefined = options.browser ? undefined : env.NAMECHEAP_TOTP_SECRET ? parseTotp(env.NAMECHEAP_TOTP_SECRET) : (accountChanged ? undefined : saved?.totp);
    if (options.totpQr) totp = await importTotpQr(options.totpQr);
    if (options.totpSecret) totp = parseTotp(await ask("Authenticator setup secret or otpauth URI (hidden): ", true));
    const credentialChanged = accountChanged || (!options.browser && Boolean(env.NAMECHEAP_PASSWORD && env.NAMECHEAP_PASSWORD !== saved?.password));
    const fresh = options.fresh || credentialChanged || options.setupCredentials || options.totpSecret || Boolean(options.totpQr);
    const existing = fresh ? null : await manager.loadSession(profile);
    if (existing && !options.browser) {
        let valid: boolean | null;
        if (options.domain) {
            try {
                const client = new NamecheapClient(existing, options.domain, { retries: 0, timeoutMs: 10_000 });
                valid = await client.isSessionValid();
                if (valid) Object.assign(existing, client.exportSession());
            }
            catch (error) { if (!(error instanceof CloudflareBlockedError)) throw error; valid = null; }
        } else valid = await manager.checkSession(existing);
        if (valid === true) {
            await manager.saveSession(existing, profile);
            log("Already logged in. Saved session is valid.");
            return { session: existing, reused: true, credentialsSaved: false };
        }
    }
    const credentials = async () => {
        username ||= await ask("Namecheap username: ");
        password ||= await ask("Namecheap password (hidden): ", true);
        if (!username || !password) throw new Error("Username and password cannot be empty.");
        return { username, password };
    };
    const session = await manager.login({
        profile, headless: !options.browser, fresh: Boolean(fresh), username, password, totp,
        promptCredentials: credentials,
        promptCode: message => ask(message, true), log,
    });
    let credentialsSaved = false;
    if (!options.browser && options.saveCredentials !== false && username && password) {
        await saveLoginProfile(manager, profile, { username, password, totp });
        credentialsSaved = true;
        log("Login credentials saved privately for automatic login. Use --no-save-credentials to opt out.");
    }
    return { session, reused: false, credentialsSaved };
}
