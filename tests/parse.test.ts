import { describe, it, expect } from "vitest";
import { parseForwardersResponse, isCloudflareBlock, parseForwardersFromHtml, parseMutationResponse } from "../src/parse.js";
import { SessionExpiredError } from "../src/types.js";

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

describe("parse.ts safety", () => {
    it("throws SessionExpiredError for a login page instead of returning []", () => {
        expect(() => parseForwardersResponse('<form action="/myaccount/login"><input name="LoginUserName"></form>')).toThrow(SessionExpiredError);
    });

    it("throws on unrecognized HTML instead of returning []", () => {
        expect(() => parseForwardersResponse("<html><body>Something new</body></html>")).toThrow(/Unrecognized/);
    });

    it("returns [] for a domain with no forwards", () => {
        expect(parseForwardersResponse(JSON.stringify({ Result: JSON.stringify({ RedirectEmailDetails: null }) }))).toEqual([]);
    });

    it("interprets mutation responses", () => {
        expect(parseMutationResponse('{"Result":true}', 200).alreadyExisted).toBe(false);
        expect(parseMutationResponse('{"Result":false,"Msg":"Forwarder already exists"}', 200).alreadyExisted).toBe(true);
        expect(() => parseMutationResponse('{"Result":false,"Msg":"Invalid mailbox"}', 200)).toThrow(/Invalid mailbox/);
        expect(() => parseMutationResponse("{}", 200)).toThrow(/rejected/);
        expect(() => parseMutationResponse("", 401)).toThrow(SessionExpiredError);
    });
});

it("rejects rejected and unknown JSON lists instead of interpreting them as empty domains", () => {
    expect(() => parseForwardersResponse('{"Success":false,"Result":{},"Msg":"Denied"}')).toThrow("Denied");
    expect(() => parseForwardersResponse('{"Result":{}}')).toThrow("missing forwarder list");
});

it("fails closed on malformed list entries instead of dropping them silently", () => {
    expect(() => parseForwardersResponse('{"Result":{"Forwarders":[{"MailBox":"a"}]}}')).toThrow("Unrecognized forwarder entry");
});
