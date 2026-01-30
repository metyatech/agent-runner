import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

export type AgentRunnerConfig = {
  owner: string;
  repos?: "all" | string[];
  workdirRoot: string;
  pollIntervalSeconds: number;
  concurrency: number;
  labels: {
    request: string;
    queued: string;
    running: string;
    done: string;
    failed: string;
  };
  codex: {
    command: string;
    args: string[];
    promptTemplate: string;
  };
};

const schemaPath = path.resolve("schema", "agent-runner.schema.json");

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
