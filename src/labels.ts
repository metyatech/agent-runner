import type { AgentRunnerConfig } from "./config.js";
import {
  resolveReviewFollowupActionRequiredLabel,
  resolveReviewFollowupWaitingLabel
} from "./review-followup-labels.js";

export type LabelDefinition = {
  name: string;
  color: string;
  description: string;
};

export function buildAgentLabels(config: AgentRunnerConfig): LabelDefinition[] {
  return [
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
      name: config.labels.needsUserReply,
      color: "F9D0C4",
      description: "Agent paused and waiting for user reply."
    },
    {
      name: config.labels.reviewFollowup,
      color: "0E8A16",
      description: "Managed PR review follow-up is queued."
    },
    {
      name: resolveReviewFollowupWaitingLabel(config),
      color: "1D76DB",
      description: "Managed PR review follow-up is waiting for idle engine availability."
    },
    {
      name: resolveReviewFollowupActionRequiredLabel(config),
      color: "B60205",
      description: "Managed PR review follow-up requires manual action."
    }
  ];
}
