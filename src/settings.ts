import { SessionManager } from "./session-manager.js";
import { readPrivateJson, writePrivateJson, removePrivateFile } from "./private-store.js";
import { formatDomain } from "./helpers.js";

function settingsPath(profile: string, manager: SessionManager) {
    return manager.getSessionPath(profile).replace(/\.session\.json$/, ".settings.json");
}
export async function selectedDomain(profile: string, manager = new SessionManager()): Promise<string | undefined> {
    const data = await readPrivateJson(settingsPath(profile, manager));
    if (data === null) return undefined;
    if (typeof data !== "object" || Array.isArray(data) || typeof (data as Record<string, unknown>).domain !== "string") throw new Error("Invalid domain selection. Run ncf use --clear.");
    return formatDomain((data as { domain: string }).domain);
}
export async function selectDomain(profile: string, domain: string, manager = new SessionManager()): Promise<void> {
    await writePrivateJson(settingsPath(profile, manager), { domain: formatDomain(domain) });
}
export async function clearDomain(profile: string, manager = new SessionManager()): Promise<void> {
    await removePrivateFile(settingsPath(profile, manager));
}
