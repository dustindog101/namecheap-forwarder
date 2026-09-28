import fs from "node:fs/promises";
import path from "node:path";
import { isValidSecret, maskSecret, normalizeSecret } from "./totp.js";

/**
 * Resolves and persists the TOTP seed used to clear Namecheap's 2FA gate.
 *
 * Precedence (highest first):
 *   1. NAMECHEAP_TOTP_SECRET — for CI / one-off automation
 *   2. <sessionDir>/<domain>.totp — per-domain file written by `ncf 2fa setup`
 *
 * The per-domain file is created with 0600 because the seed is a permanent
 * credential, not a convenience value.
 */

export const TOTP_ENV_VAR = "NAMECHEAP_TOTP_SECRET";
export const TOTP_FILE_SUFFIX = ".totp";
export const TOTP_FILE_MODE = 0o600;

export type TotpSecretSource = "env" | "file" | null;

export type ResolvedTotpSecret = {
    secret: string;
    source: Exclude<TotpSecretSource, null>;
    /** Where the value came from, safe to print (file path or env var name). */
    location: string;
};

export function getTotpSecretPath(sessionDir: string, domain: string): string {
    return path.join(sessionDir, `${domain.toLowerCase()}${TOTP_FILE_SUFFIX}`);
}

/**
 * Reads the TOTP seed for a domain, or null when 2FA must be completed manually.
 */
export async function resolveTotpSecret(
    domain: string,
    sessionDir: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTotpSecret | null> {
    const fromEnv = env[TOTP_ENV_VAR];
    if (fromEnv && isValidSecret(fromEnv)) {
        return { secret: normalizeSecret(fromEnv), source: "env", location: TOTP_ENV_VAR };
    }

    const filePath = getTotpSecretPath(sessionDir, domain);
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        const secret = normalizeSecret(raw);
        if (isValidSecret(secret)) {
            return { secret, source: "file", location: filePath };
        }
    } catch {
        // no seed on disk for this domain
    }

    return null;
}

/**
 * Validates and writes a seed to the per-domain file with restrictive
 * permissions. Returns the masked value so callers never log the raw seed.
 */
export async function saveTotpSecret(
    domain: string,
    secret: string,
    sessionDir: string,
): Promise<{ path: string; masked: string }> {
    if (!isValidSecret(secret)) {
        throw new Error(
            "That does not look like a base32 authenticator seed (expected letters A-Z and digits 2-7, at least 8 characters).",
        );
    }

    const filePath = getTotpSecretPath(sessionDir, domain);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(filePath, `${normalizeSecret(secret)}\n`, { encoding: "utf-8", mode: TOTP_FILE_MODE });
    // writeFile's mode only applies when creating the file; enforce it either way.
    await fs.chmod(filePath, TOTP_FILE_MODE);

    return { path: filePath, masked: maskSecret(secret) };
}

export async function removeTotpSecret(domain: string, sessionDir: string): Promise<boolean> {
    try {
        await fs.unlink(getTotpSecretPath(sessionDir, domain));
        return true;
    } catch {
        return false;
    }
}
