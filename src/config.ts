import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

export type AgentRunnerConfig = {
  owner: string;
  repos?: "all" | string[];
  workdirRoot: string;
  pollIntervalSeconds: number;
  concurrency: number;
  logMaintenance?: {
    enabled: boolean;
    maxAgeDays?: number;
    keepLatest?: number;
    maxTotalMB?: number;
    taskRunKeepLatest?: number;
    writeLatestPointers?: boolean;
  };
  amazonQ?: {
    enabled: boolean;
    command: string;
    args: string[];
    promptMode?: "stdin" | "arg";
    timeoutSeconds?: number;
  };
  idle?: {
    enabled: boolean;
    maxRunsPerCycle: number;
    cooldownMinutes: number;
    tasks: string[];
    promptTemplate: string;
    repoScope?: "all" | "local";
    usageGate?: {
      enabled: boolean;
      command: string;
      args: string[];
      timeoutSeconds: number;
      minRemainingPercent: {
        fiveHour: number;
      };
      weeklySchedule: {
        startMinutes: number;
        minRemainingPercentAtStart: number;
        minRemainingPercentAtEnd: number;
      };
    };
    copilotUsageGate?: {
      enabled: boolean;
      timeoutSeconds: number;
      apiBaseUrl?: string;
      apiVersion?: string;
      monthlySchedule: {
        startMinutes: number;
        minRemainingPercentAtStart: number;
        minRemainingPercentAtEnd: number;
      };
    };
    geminiUsageGate?: {
      enabled: boolean;
      strategy: "spare-only";
      startMinutes: number;
      minRemainingPercentAtStart: number;
      minRemainingPercentAtEnd: number;
    };
  };
  labels: {
    request: string;
    queued: string;
    running: string;
    done: string;
    failed: string;
    needsUser: string;
  };
  codex: {
    command: string;
    args: string[];
    promptTemplate: string;
  };
  gemini?: {
    command: string;
    args: string[];
  };
  webhooks?: {
    enabled: boolean;
    host: string;
    port: number;
    path: string;
    secret?: string;
    secretEnv?: string;
    maxPayloadBytes?: number;
    queueFile?: string;
    catchup?: {
      enabled: boolean;
      intervalMinutes: number;
      maxIssuesPerRun: number;
    };
  };
  copilot?: {
    command: string;
    args: string[];
  };
};

const schemaPath = fileURLToPath(
  new URL("../schema/agent-runner.schema.json", import.meta.url)
);

export function loadConfig(configPath: string): AgentRunnerConfig {
  const raw = fs.readFileSync(configPath, "utf8");
  const json = JSON.parse(raw) as unknown;
  const schemaRaw = fs.readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(schemaRaw) as object;

  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(json);

  if (!valid) {
    const errors = validate.errors
      ?.map((error) => `${error.instancePath || "<root>"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid config: ${errors}`);
  }

  return json as AgentRunnerConfig;
}
