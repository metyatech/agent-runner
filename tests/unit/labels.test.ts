import { describe, expect, it } from "vitest";
import { buildAgentLabels } from "../../src/labels.js";

describe("buildAgentLabels", () => {
  it("returns five labeled definitions", () => {
    const labels = buildAgentLabels({
      owner: "metyatech",
      repos: "all",
      workdirRoot: "D:/ghws",
      pollIntervalSeconds: 60,
      concurrency: 8,
      labels: {
        queued: "agent:queued",
        running: "agent:running",
        done: "agent:done",
        failed: "agent:failed",
        needsUserReply: "agent:needs-user"
      },
      codex: {
        command: "codex",
        args: ["exec"],
        promptTemplate: "template"
      }
    });

    expect(labels.map((label) => label.name)).toEqual([
      "agent:queued",
      "agent:running",
      "agent:done",
      "agent:failed",
      "agent:needs-user"
    ]);
  });
});

