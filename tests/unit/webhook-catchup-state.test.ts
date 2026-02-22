import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadWebhookCatchupState,
  resolveWebhookCatchupStatePath,
  saveWebhookCatchupState
} from "../../src/webhook-catchup-state.js";

describe("webhook-catchup-state", () => {
  it("loads default state when missing and persists lastRunAt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-catchup-"));
    const statePath = resolveWebhookCatchupStatePath(root);

    const empty = loadWebhookCatchupState(statePath);
    expect(empty.lastRunAt).toBe(null);

    saveWebhookCatchupState(statePath, { lastRunAt: "2026-02-03T00:00:00Z" });
    const loaded = loadWebhookCatchupState(statePath);
    expect(loaded.lastRunAt).toBe("2026-02-03T00:00:00Z");
  });
});
