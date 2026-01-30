import type { AgentRunnerConfig } from "./config.js";

export type LabelDefinition = {
  name: string;
  color: string;
  description: string;
};

export function buildAgentLabels(config: AgentRunnerConfig): LabelDefinition[] {
  return [
    {
      name: config.labels.request,
      color: "0E8A16",
      description: "Agent request awaiting triage."
    },
    {
      name: config.labels.queued,
      color: "FBCA04",
      description: "Queued for agent execution."
    },
    {
      name: config.labels.running,
      color: "1D76DB",
      description: "Agent is executing this request."
    },
    {
      name: config.labels.done,
      color: "5319E7",
      description: "Agent completed successfully."
    },
    {
      name: config.labels.failed,
      color: "B60205",
      description: "Agent failed to complete the request."
    },
    {
      name: config.labels.needsUser,
      color: "F9D0C4",
      description: "Agent awaiting user response."
    }
  ];
}
