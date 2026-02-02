import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearStopRequest,
  isStopRequested,
  requestStop,
  resolveStopFlagPath
} from "../../src/stop-flag.js";

describe("stop-flag", () => {
  it("creates and clears stop requests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-stop-"));
    expect(isStopRequested(root)).toBe(false);
    requestStop(root);
    expect(isStopRequested(root)).toBe(true);
    const stopPath = resolveStopFlagPath(root);
    expect(fs.existsSync(stopPath)).toBe(true);
    clearStopRequest(root);
    expect(isStopRequested(root)).toBe(false);
  });
});
