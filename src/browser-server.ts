import type { BrowserServer } from "playwright-core";
import { loadPlaywright } from "./playwright.js";

export type BrowserServerOptions = {
    port?: number;
    /** Fixed path so the endpoint is predictable (Playwright otherwise picks a random one). */
    wsPath?: string;
    /** Interface to listen on. Default 127.0.0.1 — the endpoint gives full control of the browser. */
    host?: string;
};

/**
 * Starts a long-lived headless Chromium that StealthNamecheapClient can connect to via
 * `wsEndpoint`, so each operation skips the ~1–2s browser launch.
 */
export async function startBrowserServer(options: BrowserServerOptions | number = {}): Promise<BrowserServer> {
    const opts = typeof options === "number" ? { port: options } : options;
    if (!Number.isInteger(opts.port ?? 3000) || (opts.port ?? 3000) < 0 || (opts.port ?? 3000) > 65535) throw new Error("Port must be an integer from 0 to 65535 (0 chooses an available port).");
    const { chromium } = await loadPlaywright();
    const launch = {
        headless: true,
        port: opts.port ?? 3000,
        wsPath: opts.wsPath ?? "/namecheap",
        host: opts.host ?? "127.0.0.1",
    };
    try { return await chromium.launchServer({ ...launch, channel: "chrome" }); }
    catch (chromeError) {
        try { return await chromium.launchServer(launch); }
        catch (error) {
            if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
                const original = chromeError instanceof Error ? chromeError.message : String(chromeError);
                if (!/doesn't exist|not found|distribution/i.test(original)) throw new Error("Chrome could not start. Check browser permissions and sandbox restrictions.");
                throw new Error("No browser found. Install Google Chrome, or run: npx playwright install chromium");
            }
            throw error;
        }
    }
}
