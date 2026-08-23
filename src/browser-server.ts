import { chromium } from "playwright-core";

export async function startBrowserServer(port: number = 3000) {
    console.log(`Starting headless browser server on ws://localhost:${port}`);
    
    const server = await chromium.launchServer({
        port,
        headless: true,
    });
    
    console.log(`Browser server is running at ${server.wsEndpoint()}`);
    return server;
}
