import fs from "node:fs";
import path from "node:path";
import * as nodeOs from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("fetchGeminiUsage (credentials refresh)", () => {
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_ID;
  const originalClientSecret = process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_SECRET;

  beforeEach(() => {
    vi.resetModules();
    process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_ID = "test-client-id";
    process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_SECRET = "test-client-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    vi.resetModules();
    if (typeof originalClientId === "string") {
      process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_ID = originalClientId;
    } else {
      delete process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_ID;
    }
    if (typeof originalClientSecret === "string") {
      process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_SECRET = originalClientSecret;
    } else {
      delete process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_SECRET;
    }
  });

  it("refreshes OAuth access token with grant_type=refresh_token", async () => {
    const homeDir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), "agent-runner-home-"));
    const geminiDir = path.join(homeDir, ".gemini");
    const credsPath = path.join(geminiDir, "oauth_creds.json");
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(
      credsPath,
      JSON.stringify(
        {
          access_token: "",
          expiry_date: 0,
          refresh_token: "rtok",
          client_id: "cid",
          client_secret: "csecret"
        },
        null,
        2
      ),
      "utf8"
    );

    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<any>("node:os");
      const patched = { ...actual, homedir: () => homeDir };
      return { ...patched, default: patched };
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "newtok", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cloudaicompanionProject: "projects/p1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            buckets: [
              {
                modelId: "gemini-3-pro-preview",
                remainingFraction: 0.9,
                resetTime: "2026-02-03T11:00:00Z"
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    const { fetchGeminiUsage } = await import("../../src/gemini-usage.js");
    const usage = await fetchGeminiUsage();

    expect(usage?.["gemini-3-pro-preview"]?.usage).toBe(10);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, any];
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(tokenInit?.method).toBe("POST");
    expect(tokenInit?.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenInit?.body).toContain("grant_type=refresh_token");
    expect(tokenInit?.body).toContain("refresh_token=rtok");
    expect(tokenInit?.body).toContain("client_id=test-client-id");
    expect(tokenInit?.body).toContain("client_secret=test-client-secret");
    expect(tokenInit?.body).not.toContain("client_id=cid");
    expect(tokenInit?.body).not.toContain("client_secret=csecret");

    const updated = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    expect(updated.access_token).toBe("newtok");
    expect(updated.expiry_date).toBeGreaterThan(Date.now());

    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});
