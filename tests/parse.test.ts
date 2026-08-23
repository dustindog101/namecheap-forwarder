import { describe, it, expect } from "vitest";
import { parseForwardersResponse, isCloudflareBlock, parseForwardersFromHtml } from "../src/parse.js";

describe("parse.ts", () => {
    it("detects Cloudflare blocks", () => {
        expect(isCloudflareBlock("cloudflare", 403)).toBe(true);
        expect(isCloudflareBlock("Just a moment... enable JavaScript and cookies", 200)).toBe(true);
        expect(isCloudflareBlock("success", 200)).toBe(false);
    });

    it("parses JSON forwards with Forwarders array", () => {
        const json = JSON.stringify({
            Result: {
                Forwarders: [
                    { MailboxName: "hello", ForwardTo: "test@example.com", MailboxId: 123 }
                ]
            }
        });
        const result = parseForwardersResponse(json);
        expect(result).toEqual([{ alias: "hello", forwardTo: "test@example.com", mailboxId: 123 }]);
    });

    it("parses JSON forwards with RedirectEmailDetails (stringified Result)", () => {
        const json = JSON.stringify({
            Result: JSON.stringify({
                RedirectEmailDetails: [
                    { MailBox: "support", ForwardTo: "team@example.com", MailBoxId: 789 }
                ]
            })
        });
        const result = parseForwardersResponse(json);
        expect(result).toEqual([{ alias: "support", forwardTo: "team@example.com", mailboxId: 789 }]);
    });

    it("parses HTML nc_state script correctly", () => {
        const html = `<html><script>window.nc_state = ${JSON.stringify({
            DomainDetails: {
                Forwarders: [
                    { MailboxName: "admin", ForwardTo: "admin@example.com", MailboxId: 456 }
                ]
            }
        })};</script></html>`;
        const result = parseForwardersResponse(html);
        expect(result).toEqual([{ alias: "admin", forwardTo: "admin@example.com", mailboxId: 456 }]);
    });

    it("parses forwards from HTML data attributes fallback", () => {
        const html = `
            <div class="row" data-mailbox-name="billing" data-forward-to="billing@example.com"></div>
            <div class="row" data-mailbox-name="security" data-forward-to="sec@example.com"></div>
        `;
        const result = parseForwardersFromHtml(html);
        expect(result).toEqual([
            { alias: "billing", forwardTo: "billing@example.com" },
            { alias: "security", forwardTo: "sec@example.com" }
        ]);
    });
});
