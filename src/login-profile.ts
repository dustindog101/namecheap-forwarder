import { createInterface } from "node:readline/promises";
import { SessionManager } from "./session-manager.js";
import { readPrivateJson, writePrivateJson, removePrivateFile } from "./private-store.js";
import { parseTotp, type TotpConfig } from "./totp.js";

export type LoginProfile = { username: string; password: string; totp?: TotpConfig };
export function credentialPath(manager: SessionManager, profile: string): string {
    return manager.getSessionPath(profile).replace(/\.session\.json$/, ".credentials.json");
}
export async function loadLoginProfile(manager: SessionManager, profile: string): Promise<LoginProfile | null> {
    const value = await readPrivateJson(credentialPath(manager, profile));
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved login profile. Run ncf logout to reset it.");
    const data = value as Record<string, unknown>;
    if (typeof data.username !== "string" || typeof data.password !== "string") throw new Error("Invalid saved login profile. Run ncf logout to reset it.");
    let totp: TotpConfig | undefined;
    if (data.totp !== undefined) {
        const t = data.totp as TotpConfig;
        try { totp = parseTotp(`otpauth://totp/account?secret=${encodeURIComponent(t.secret)}&algorithm=${t.algorithm}&digits=${t.digits}&period=${t.period}`); }
        catch { throw new Error("Invalid saved authenticator setup. Run ncf logout to reset it."); }
    }
    return { username: data.username, password: data.password, totp };
}
export async function saveLoginProfile(manager: SessionManager, profile: string, value: LoginProfile): Promise<void> {
    await writePrivateJson(credentialPath(manager, profile), value);
}
export async function deleteLoginProfile(manager: SessionManager, profile: string): Promise<boolean> {
    return removePrivateFile(credentialPath(manager, profile));
}
export async function promptLoginValue(label: string, hidden = false): Promise<string> {
    if (!process.stdin.isTTY) throw new Error("Interactive login needs a terminal. Set credentials through environment variables instead.");
    if (!hidden) {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try { return (await rl.question(label)).trim(); } finally { rl.close(); }
    }
    process.stderr.write(label);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let value = "";
        const finish = (error?: Error) => {
            process.stdin.removeListener("data", onData);
            process.stdin.setRawMode(wasRaw);
            process.stdin.pause();
            process.stderr.write("\n");
            error ? reject(error) : resolve(value);
        };
        const onData = (data: Buffer) => {
            for (const char of data.toString()) {
                if (char === "\u0003") { finish(new Error("Login cancelled.")); return; }
                if (char === "\r" || char === "\n") { finish(); return; }
                if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
                else if (char >= " ") value += char;
            }
        };
        process.stdin.on("data", onData);
    });
}
