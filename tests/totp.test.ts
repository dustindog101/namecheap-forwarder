import { describe, expect, it } from "vitest";
import { generateTotp, parseTotp } from "../src/totp.js";

describe("TOTP", () => {
    const config = parseTotp("otpauth://totp/test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8");
    it.each([[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]])("matches RFC 6238 at %s seconds", (seconds, code) => {
        expect(generateTotp(config, Number(seconds) * 1000)).toBe(code);
    });
    it("parses default Base32 settings", () => {
        expect(parseTotp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toMatchObject({ algorithm: "sha1", period: 30, digits: 6 });
    });
    it.each(["123456", "otpauth://hotp/a?secret=GEZDGNBVGY3TQOJQ", "otpauth://totp/a?secret=GEZDGNBVGY3TQOJQ&digits=9", "otpauth://totp/a?secret=GEZDGNBVGY3TQOJQ&period=0", "otpauth://totp/a?secret=GEZDGNBVGY3TQOJQ&algorithm=MD5"])("rejects unsupported setup", input => expect(() => parseTotp(input)).toThrow());
});

it("imports an actual authenticator QR image", async () => {
    const { importTotpQr } = await import("../src/totp.js");
    const { fileURLToPath } = await import("node:url");
    expect(await importTotpQr(fileURLToPath(new URL("./fixtures/authenticator.png", import.meta.url)))).toEqual(parseTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"));
});

it("imports JPEG QR images and rejects unrelated images", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { PNG } = await import("pngjs");
    const { default: jpeg } = await import("jpeg-js");
    const { importTotpQr } = await import("../src/totp.js");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ncf-qr-"));
    try {
        const fixture = PNG.sync.read(await fs.readFile(fileURLToPath(new URL("./fixtures/authenticator.png", import.meta.url))));
        const file = path.join(dir, "qr.jpg");
        await fs.writeFile(file, jpeg.encode(fixture, 95).data);
        expect(await importTotpQr(file)).toEqual(parseTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"));
        const blank = new PNG({ width: 40, height: 40 });
        blank.data.fill(255);
        await fs.writeFile(file, PNG.sync.write(blank));
        await expect(importTotpQr(file)).rejects.toThrow("No authenticator QR code");
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
