import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isGeminiModelBlockedByCapacity,
  loadGeminiCapacityBackoffState,
  recordGeminiCapacityBackoff,
  resolveGeminiCapacityBackoffStatePath
} from "../../src/gemini-capacity-backoff.js";

describe("gemini-capacity-backoff", () => {
  it("records and loads blockedUntil per model", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-gemini-capacity-"));
    const statePath = resolveGeminiCapacityBackoffStatePath(root);

    const now = new Date("2026-02-20T00:00:00.000Z");
    const blockedUntil = new Date("2026-02-20T01:00:00.000Z");
    recordGeminiCapacityBackoff(statePath, "gemini-3-flash-preview", blockedUntil);

    const loaded = loadGeminiCapacityBackoffState(statePath);
    expect(isGeminiModelBlockedByCapacity(loaded, "gemini-3-flash-preview", now)).toBe(true);
    expect(isGeminiModelBlockedByCapacity(loaded, "gemini-3-flash-preview", blockedUntil)).toBe(
      false
    );
    expect(isGeminiModelBlockedByCapacity(loaded, "gemini-3-pro-preview", now)).toBe(false);
  });
});
