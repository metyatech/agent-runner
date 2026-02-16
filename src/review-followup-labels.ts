import type { AgentRunnerConfig } from "./config.js";

export type ReviewFollowupLabelState = "queued" | "waiting" | "action-required" | "none";

function normalizeOptionalLabel(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveReviewFollowupWaitingLabel(config: AgentRunnerConfig): string {
  return normalizeOptionalLabel(config.labels.reviewFollowupWaiting) ?? `${config.labels.reviewFollowup}:waiting`;
}

export function resolveReviewFollowupActionRequiredLabel(config: AgentRunnerConfig): string {
  return (
    normalizeOptionalLabel(config.labels.reviewFollowupActionRequired) ??
    `${config.labels.reviewFollowup}:action-required`
  );
}

export function listReviewFollowupLabels(config: AgentRunnerConfig): string[] {
  const all = [
    config.labels.reviewFollowup,
    resolveReviewFollowupWaitingLabel(config),
    resolveReviewFollowupActionRequiredLabel(config)
  ];
  return Array.from(new Set(all));
}

export function labelsForReviewFollowupState(
  config: AgentRunnerConfig,
  state: ReviewFollowupLabelState
): string[] {
  if (state === "none") {
    return [];
  }
  if (state === "queued") {
    return [config.labels.reviewFollowup];
  }
  if (state === "waiting") {
    return [config.labels.reviewFollowup, resolveReviewFollowupWaitingLabel(config)];
  }
  return [resolveReviewFollowupActionRequiredLabel(config)];
}
