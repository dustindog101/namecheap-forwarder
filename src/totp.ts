import { createHmac } from "node:crypto";

export type TotpConfig = { secret: string; algorithm: "sha1" | "sha256" | "sha512"; digits: number; period: number };

function decodeBase32(secret: string): Buffer {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const input = secret.toUpperCase().replace(/\s/g, "").replace(/=+$/, "");
    if (!input || /[^A-Z2-7]/.test(input)) throw new Error("Invalid Base32 authenticator secret.");
    let bits = 0, value = 0;
    const bytes: number[] = [];
    for (const char of input) {
        value = (value << 5) | alphabet.indexOf(char);
        bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    }
    if (bytes.length < 10) throw new Error("Authenticator secret is too short.");
    return Buffer.from(bytes);
}

export function parseTotp(input: string): TotpConfig {
    let config: TotpConfig = { secret: input.trim(), algorithm: "sha1", digits: 6, period: 30 };
    if (input.trim().startsWith("otpauth://")) {
        let url: URL;
        try { url = new URL(input.trim()); } catch { throw new Error("Invalid authenticator setup URI."); }
        if (url.hostname !== "totp") throw new Error("Only TOTP authenticator QR codes are supported.");
        config = {
            secret: url.searchParams.get("secret") ?? "",
            algorithm: (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase() as TotpConfig["algorithm"],
            digits: Number(url.searchParams.get("digits") ?? 6),
            period: Number(url.searchParams.get("period") ?? 30),
        };
    }
    decodeBase32(config.secret);
    if (!["sha1", "sha256", "sha512"].includes(config.algorithm) || ![6, 8].includes(config.digits) || !Number.isInteger(config.period) || config.period < 1 || config.period > 300) {
        throw new Error("Unsupported authenticator parameters.");
    }
    return config;
}

export function generateTotp(config: TotpConfig, time = Date.now()): string {
    // Validate stored input too; never let malformed profile data reach crypto.
    const checked = parseTotp(`otpauth://totp/account?secret=${encodeURIComponent(config.secret)}&algorithm=${config.algorithm}&digits=${config.digits}&period=${config.period}`);
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / checked.period)));
    const hash = createHmac(checked.algorithm, decodeBase32(checked.secret)).update(counter).digest();
    const offset = hash[hash.length - 1] & 15;
    return ((hash.readUInt32BE(offset) & 0x7fffffff) % (10 ** checked.digits)).toString().padStart(checked.digits, "0");
}

export async function importTotpQr(file: string): Promise<TotpConfig> {
    const fs = await import("node:fs/promises");
    if ((await fs.stat(file)).size > 20_000_000) throw new Error("QR image is too large (maximum 20 MB).");
    const bytes = await fs.readFile(file);
    if (bytes.length > 20_000_000) throw new Error("QR image is too large (maximum 20 MB).");
    let decoded: { data: Uint8Array; width: number; height: number };
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        if (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_000_000) throw new Error("QR image dimensions exceed the limit.");
        const { PNG } = await import("pngjs");
        decoded = PNG.sync.read(bytes);
    } else if (bytes[0] === 255 && bytes[1] === 216) {
        const { default: jpeg } = await import("jpeg-js");
        decoded = jpeg.decode(bytes, { maxResolutionInMP: 16, maxMemoryUsageInMB: 128 });
    } else throw new Error("QR import supports PNG and JPEG images.");
    const { default: jsQR } = await import("jsqr");
    const code = jsQR(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height);
    if (!code) throw new Error("No authenticator QR code found in the image.");
    if (!code.data.startsWith("otpauth://")) throw new Error("QR image does not contain an authenticator setup URI.");
    return parseTotp(code.data);
}
