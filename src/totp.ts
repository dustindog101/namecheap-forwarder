import { createHmac } from "node:crypto";

/**
 * Dependency-free TOTP (RFC 6238) generator.
 *
 * Namecheap's login gate at https://www.namecheap.com/twofa/totp/ expects a
 * 6-digit, 30-second, HMAC-SHA1 code — i.e. exactly what a phone authenticator
 * app shows. Given the shared seed from Namecheap's 2FA enrolment, the code can
 * be computed locally and the login completed without a human in the loop.
 *
 * The seed is a long-lived credential: anyone holding it can mint valid codes
 * forever. Treat it with the same care as a password.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_LOOKUP: Record<string, number> = Object.fromEntries(
    [...BASE32_ALPHABET].map((char, i) => [char, i]),
);

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

export type TotpOptions = {
    /** Number of digits in the emitted code. Namecheap uses 6. Default: 6. */
    digits?: number;
    /** Time step in seconds. Namecheap uses 30. Default: 30. */
    period?: number;
    /** HMAC variant. Namecheap uses SHA1. Default: "sha1". */
    algorithm?: TotpAlgorithm;
};

export type TotpCode = {
    /** The numeric code, zero-padded to the configured digit count. */
    code: string;
    /** Time step in seconds the code was derived from. */
    period: number;
    /** Seconds remaining before this code stops being accepted. */
    validForSeconds: number;
    /** Unix time (ms) the code was generated for. */
    timestamp: number;
};

export const DEFAULT_TOTP_OPTIONS: Required<TotpOptions> = {
    digits: 6,
    period: 30,
    algorithm: "sha1",
};

/**
 * Strips the cosmetic formatting authenticator apps display (spaces, dashes)
 * and upper-cases the seed so pasted values work verbatim.
 */
export function normalizeSecret(secret: string): string {
    return (secret || "").replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Decodes a base32 seed into raw bytes.
 * `Buffer` has no base32 encoding, hence the explicit bit-packing.
 */
export function decodeBase32(input: string): Buffer {
    const normalized = normalizeSecret(input).replace(/=+$/, "");
    if (!normalized) throw new Error("TOTP secret is empty");

    let bits = 0;
    let value = 0;
    const out: number[] = [];

    for (const char of normalized) {
        const index = BASE32_LOOKUP[char];
        if (index === undefined) {
            throw new Error(
                `TOTP secret contains an invalid base32 character: ${JSON.stringify(char)}`,
            );
        }
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out.push((value >>> bits) & 0xff);
        }
    }

    return Buffer.from(out);
}

/**
 * Validates a base32 TOTP seed without throwing.
 * Rejects empty values, non-base32 characters, and seeds too short to be a
 * real authenticator key (Namecheap issues 16-byte / 32-character seeds).
 */
export function isValidSecret(secret: string | null | undefined): boolean {
    if (!secret) return false;
    const normalized = normalizeSecret(secret);
    if (normalized.length < 8) return false;
    if (![...normalized].every((char) => BASE32_LOOKUP[char] !== undefined)) return false;
    try {
        return decodeBase32(normalized).length >= 8;
    } catch {
        return false;
    }
}

/**
 * Seconds left in the current time step. Use this to decide whether a code is
 * safe to submit or whether to wait for the next window first.
 */
export function secondsRemaining(period: number = DEFAULT_TOTP_OPTIONS.period, at: number = Date.now()): number {
    const stepMs = period * 1000;
    return stepMs - (((at % stepMs) + stepMs) % stepMs);
}

/**
 * Generates the current TOTP code.
 *
 * @param secret base32 seed from the authenticator enrolment (spaces/dashes ok)
 * @param options digits / period / algorithm — defaults match Namecheap
 * @param at injectable clock (ms) for deterministic tests
 */
export function generateTotp(
    secret: string,
    options: TotpOptions = {},
    at: number = Date.now(),
): TotpCode {
    const { digits, period, algorithm } = { ...DEFAULT_TOTP_OPTIONS, ...options };

    if (!isValidSecret(secret)) {
        throw new Error("Invalid TOTP secret: expected a base32 authenticator seed");
    }

    const key = decodeBase32(secret);
    const counter = Math.floor(at / 1000 / period);

    // 64-bit big-endian counter, as required by RFC 4226 §5.
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuf.writeUInt32BE(counter >>> 0, 4);

    const digest = createHmac(algorithm, key).update(counterBuf).digest();

    // Dynamic truncation (RFC 4226 §5.3).
    const offset = digest[digest.length - 1] & 0x0f;
    const binary =
        ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff);

    const modulus = 10 ** digits;

    return {
        code: String(binary % modulus).padStart(digits, "0"),
        period,
        validForSeconds: Math.ceil(secondsRemaining(period, at) / 1000),
        timestamp: at,
    };
}

/**
 * Masks a seed for logging: never print a full seed or a full code.
 */
export function maskSecret(secret: string): string {
    const normalized = normalizeSecret(secret);
    if (normalized.length <= 4) return "•".repeat(normalized.length);
    return `${"•".repeat(8)}${normalized.slice(-4)}`;
}
