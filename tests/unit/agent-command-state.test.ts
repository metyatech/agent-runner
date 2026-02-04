import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hasProcessedAgentCommandComment,
  markAgentCommandCommentProcessed,
  resolveAgentCommandStatePath
} from "../../src/agent-command-state.js";

describe("agent-command-state", () => {
  it("records processed comment ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-command-state-"));
    const statePath = resolveAgentCommandStatePath(root);

    expect(await hasProcessedAgentCommandComment(statePath, 123)).toBe(false);
    await markAgentCommandCommentProcessed(statePath, 123);
    expect(await hasProcessedAgentCommandComment(statePath, 123)).toBe(true);

    await markAgentCommandCommentProcessed(statePath, 123);
    expect(await hasProcessedAgentCommandComment(statePath, 123)).toBe(true);
  });
});

