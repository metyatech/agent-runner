import { describe, expect, it } from "vitest";
import type { AgentRunnerConfig } from "../../src/config.js";
import { idleEngineToService, resolveServiceConcurrency } from "../../src/service-concurrency.js";

function baseConfig(partial: Partial<AgentRunnerConfig> = {}): AgentRunnerConfig {
  return {
    owner: "metyatech",
    repos: "all",
    workdirRoot: "D:\\ghws",
    pollIntervalSeconds: 60,
    concurrency: 8,
    labels: {
      queued: "agent:queued",
      running: "agent:running",
      done: "agent:done",
      failed: "agent:failed",
      needsUserReply: "agent:needs-user-reply"
    },
    codex: {
      command: "codex",
      args: ["exec", "--help"],
      promptTemplate: "Template {{repos}} {{task}}"
    },
    ...partial
  };
}

describe("service-concurrency", () => {
  it("defaults to 1 per service when unset", () => {
    const resolved = resolveServiceConcurrency(baseConfig({ serviceConcurrency: undefined }));
    expect(resolved).toEqual({
      codex: 1,
      copilot: 1,
      gemini: 1,
      "amazon-q": 1
    });
  });

  it("applies overrides and falls back for invalid values", () => {
    const resolved = resolveServiceConcurrency(
      baseConfig({
        serviceConcurrency: {
          codex: 2,
          copilot: 0,
          gemini: 1.9,
          amazonQ: Number.NaN
        }
      })
    );

    expect(resolved).toEqual({
      codex: 2,
      copilot: 1,
      gemini: 1,
      "amazon-q": 1
    });
  });

  it("maps idle engines to services", () => {
    expect(idleEngineToService("codex")).toBe("codex");
    expect(idleEngineToService("copilot")).toBe("copilot");
    expect(idleEngineToService("amazon-q")).toBe("amazon-q");
    expect(idleEngineToService("gemini-pro")).toBe("gemini");
    expect(idleEngineToService("gemini-flash")).toBe("gemini");
  });
});

