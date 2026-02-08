import pLimit from "p-limit";
import type { AgentRunnerConfig } from "./config.js";
import type { IdleEngine } from "./runner.js";

export type ServiceName = "codex" | "copilot" | "gemini" | "amazon-q";

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const intValue = Math.floor(value);
  if (intValue < 1) {
    return fallback;
  }
  return intValue;
}

export function resolveServiceConcurrency(config: AgentRunnerConfig): Record<ServiceName, number> {
  const defaults: Record<ServiceName, number> = {
    codex: 1,
    copilot: 1,
    gemini: 1,
    "amazon-q": 1
  };

  const overrides = config.serviceConcurrency;
  if (!overrides) {
    return defaults;
  }

  return {
    codex: normalizePositiveInt(overrides.codex, defaults.codex),
    copilot: normalizePositiveInt(overrides.copilot, defaults.copilot),
    gemini: normalizePositiveInt(overrides.gemini, defaults.gemini),
    "amazon-q": normalizePositiveInt(overrides.amazonQ, defaults["amazon-q"])
  };
}

export function idleEngineToService(engine: IdleEngine): ServiceName {
  switch (engine) {
    case "codex":
      return "codex";
    case "copilot":
      return "copilot";
    case "amazon-q":
      return "amazon-q";
    case "gemini-pro":
    case "gemini-flash":
      return "gemini";
    default: {
      const exhaustiveCheck: never = engine;
      throw new Error(`Unsupported idle engine ${String(exhaustiveCheck)}`);
    }
  }
}

export function createServiceLimiters(
  config: AgentRunnerConfig
): Record<ServiceName, ReturnType<typeof pLimit>> {
  const concurrency = resolveServiceConcurrency(config);
  return {
    codex: pLimit(concurrency.codex),
    copilot: pLimit(concurrency.copilot),
    gemini: pLimit(concurrency.gemini),
    "amazon-q": pLimit(concurrency["amazon-q"])
  };
}

