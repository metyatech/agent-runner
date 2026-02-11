import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("fetchGeminiUsage (OAuth client discovery)", () => {
  const originalFetch = globalThis.fetch;
  const originalAppData = process.env.APPDATA;
  const originalClientId = process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_ID;
  const originalClientSecret = process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_SECRET;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_ID;
    delete process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_SECRET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    vi.resetModules();
    if (typeof originalAppData === "string") process.env.APPDATA = originalAppData;
    else delete process.env.APPDATA;
    if (typeof originalClientId === "string") process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_ID = originalClientId;
    else delete process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_ID;
    if (typeof originalClientSecret === "string")
      process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_SECRET = originalClientSecret;
    else delete process.env.AGENT_RUNNER_GEMINI_OAUTH_CLIENT_SECRET;
  });

  it("extracts OAUTH_CLIENT_SECRET from gemini-cli oauth2.js on Windows", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-home-"));
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-appdata-"));
    process.env.APPDATA = appData;

    const geminiDir = path.join(homeDir, ".gemini");
    const credsPath = path.join(geminiDir, "oauth_creds.json");
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(
      credsPath,
      JSON.stringify(
        {
          access_token: "",
          expiry_date: 0,
          refresh_token: "rtok"
        },
        null,
        2
      ),
      "utf8"
    );

    const oauth2Path = path.join(
      appData,
      "npm",
      "node_modules",
      "@google",
      "gemini-cli",
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js"
    );
    fs.mkdirSync(path.dirname(oauth2Path), { recursive: true });
    fs.writeFileSync(
      oauth2Path,
      [
        "const OAUTH_CLIENT_ID = 'cid-from-file.apps.googleusercontent.com';",
        "const OAUTH_CLIENT_SECRET = 'secret-from-file';"
      ].join("\n"),
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

    const [_tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, any];
    expect(tokenInit?.body).toContain("client_id=cid-from-file.apps.googleusercontent.com");
    expect(tokenInit?.body).toContain("client_secret=secret-from-file");

    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(appData, { recursive: true, force: true });
  });
});
