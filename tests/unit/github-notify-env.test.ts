import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGitHubNotifyChildEnv } from "../../src/github-notify-env.js";

describe("github-notify-env", () => {
  it("returns empty env when no app config is present", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-notify-env-"));
    expect(await buildGitHubNotifyChildEnv(root)).toEqual({});
  });
});
