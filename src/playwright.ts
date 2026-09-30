import type { Browser, LaunchOptions } from "playwright-core";

type PlaywrightModule = typeof import("playwright-core");

/**
 * Playwright is only needed for login and the stealth client, so it is imported lazily:
 * apps that only use NamecheapClient never load it (keeps serverless bundles small).
 */
export async function loadPlaywright(): Promise<PlaywrightModule> {
    try {
        return await import("playwright-core");
    } catch {
        throw new Error("playwright-core is not installed. Run: npm install playwright-core");
    }
}

/**
 * Launches the user's installed Google Chrome if present (less likely to trip bot checks,
 * no download needed), otherwise Playwright's bundled Chromium.
 */
export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
    const { chromium } = await loadPlaywright();
    try {
        return await chromium.launch({ ...options, channel: "chrome" });
    } catch (chromeError) {
        try {
            return await chromium.launch(options);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("Executable doesn't exist")) {
                const original = chromeError instanceof Error ? chromeError.message : String(chromeError);
                if (!/doesn't exist|not found|distribution/i.test(original)) throw new Error("Chrome could not start. Check browser permissions and sandbox restrictions, or retry with --browser.");
                throw new Error("No browser found. Install Google Chrome, or run: npx playwright install chromium");
            }
            throw err;
        }
    }
}
