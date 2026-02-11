import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGitHubNotifyAppConfig } from "../../src/github-notify-app.js";

describe("github-notify-app", () => {
  it("returns null when state config is incomplete", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-notify-app-"));
    expect(resolveGitHubNotifyAppConfig(root)).toBe(null);
  });

  it("reads app config from state files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-notify-app-"));
    const stateDir = path.join(root, "agent-runner", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "github-notify-app.json"),
      JSON.stringify({ appId: "123", installationId: 456 }, null, 2),
      "utf8"
    );
    fs.writeFileSync(path.join(stateDir, "github-notify-app-private-key.pem"), "KEY\n", "utf8");

    const resolved = resolveGitHubNotifyAppConfig(root);
    expect(resolved).not.toBe(null);
    expect(resolved?.appId).toBe("123");
    expect(resolved?.installationId).toBe(456);
    expect(resolved?.privateKey).toBe("KEY");
  });

  it("prefers env config over state files", () => {
    const prior = {
      appId: process.env.AGENT_GITHUB_NOTIFY_APP_ID,
      installationId: process.env.AGENT_GITHUB_NOTIFY_APP_INSTALLATION_ID,
      privateKey: process.env.AGENT_GITHUB_NOTIFY_APP_PRIVATE_KEY,
      apiBaseUrl: process.env.AGENT_GITHUB_NOTIFY_APP_API_BASE_URL
    };
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-notify-app-"));
      const stateDir = path.join(root, "agent-runner", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "github-notify-app.json"),
        JSON.stringify({ appId: "from-state", installationId: 999 }, null, 2),
        "utf8"
      );
      fs.writeFileSync(path.join(stateDir, "github-notify-app-private-key.pem"), "STATEKEY\n", "utf8");

      process.env.AGENT_GITHUB_NOTIFY_APP_ID = "from-env";
      process.env.AGENT_GITHUB_NOTIFY_APP_INSTALLATION_ID = "321";
      process.env.AGENT_GITHUB_NOTIFY_APP_PRIVATE_KEY = "ENVKEY";
      process.env.AGENT_GITHUB_NOTIFY_APP_API_BASE_URL = "https://api.github.com";

      const resolved = resolveGitHubNotifyAppConfig(root);
      expect(resolved).not.toBe(null);
      expect(resolved?.appId).toBe("from-env");
      expect(resolved?.installationId).toBe(321);
      expect(resolved?.privateKey).toBe("ENVKEY");
      expect(resolved?.apiBaseUrl).toBe("https://api.github.com");
    } finally {
      if (typeof prior.appId === "string") process.env.AGENT_GITHUB_NOTIFY_APP_ID = prior.appId;
      else delete process.env.AGENT_GITHUB_NOTIFY_APP_ID;
      if (typeof prior.installationId === "string")
        process.env.AGENT_GITHUB_NOTIFY_APP_INSTALLATION_ID = prior.installationId;
      else delete process.env.AGENT_GITHUB_NOTIFY_APP_INSTALLATION_ID;
      if (typeof prior.privateKey === "string") process.env.AGENT_GITHUB_NOTIFY_APP_PRIVATE_KEY = prior.privateKey;
      else delete process.env.AGENT_GITHUB_NOTIFY_APP_PRIVATE_KEY;
      if (typeof prior.apiBaseUrl === "string") process.env.AGENT_GITHUB_NOTIFY_APP_API_BASE_URL = prior.apiBaseUrl;
      else delete process.env.AGENT_GITHUB_NOTIFY_APP_API_BASE_URL;
    }
  });
});
