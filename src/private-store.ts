import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Atomic owner-only storage. Error messages never include the file contents. */
export async function readPrivateJson(file: string): Promise<unknown | null> {
    let raw: string;
    try { raw = await fs.readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error(`Cannot read ${file}. Check file permissions.`); }
    try { return JSON.parse(raw); }
    catch { throw new Error(`Invalid JSON in ${file}. Restore a backup or remove this file and log in again.`); }
}

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
        await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(() => {}); }
}

export async function removePrivateFile(file: string): Promise<boolean> {
    try { await fs.unlink(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new Error(`Cannot remove ${file}. Check file permissions.`); }
}
