import { describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  clearUiServerState,
  loadUiServerState,
  probeUiServer,
  resolveUiServerStatePath,
  saveUiServerState
} from "../../src/ui-server-control.js";

describe("ui-server-control", () => {
  it("saves and loads ui server state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-ui-state-"));
    const statePath = resolveUiServerStatePath(root);
    saveUiServerState(statePath, {
      pid: 12345,
      host: "127.0.0.1",
      port: 4311,
      startedAt: "2026-02-16T00:00:00.000Z",
      configPath: path.join(root, "agent-runner.config.json")
    });
    const loaded = loadUiServerState(statePath);
    expect(loaded).not.toBeNull();
    expect(loaded?.pid).toBe(12345);
    expect(loaded?.port).toBe(4311);
    clearUiServerState(statePath);
    expect(loadUiServerState(statePath)).toBeNull();
  });

  it("returns null for invalid ui server state content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-ui-state-"));
    const statePath = resolveUiServerStatePath(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{\"invalid\":true}", "utf8");
    expect(loadUiServerState(statePath)).toBeNull();
  });

  it("probes tcp listener state", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP address.");
      }
      const listening = await probeUiServer("127.0.0.1", address.port, 500);
      expect(listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    const notListening = await probeUiServer("127.0.0.1", 1, 200);
    expect(notListening).toBe(false);
  });
});
