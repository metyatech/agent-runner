import type { IssueComment } from "./github.js";
import { buildAgentComment, findLastMarkerComment, hasUserReplySince } from "./notifications.js";

export const REVIEW_FOLLOWUP_WAITING_MARKER = "<!-- agent-runner:review-followup:waiting -->";
export const REVIEW_FOLLOWUP_ACTION_REQUIRED_MARKER = "<!-- agent-runner:review-followup:action-required -->";

function normalizeReason(reason: string): string {
  return reason.trim().toLowerCase();
}

export function isManualActionRequiredForAutoMergeSkip(reason: string): boolean {
  const normalized = normalizeReason(reason);
  if (!normalized) {
    return true;
  }

  if (normalized === "already_merged") {
    return false;
  }
  if (normalized === "pr_not_found") {
    return false;
  }
  if (normalized.startsWith("pr_not_open:")) {
    return false;
  }

  return true;
}

function buildManualActionGuidance(reason: string): string {
  const normalized = normalizeReason(reason);
  if (normalized === "actionable_review_feedback") {
    return "Address requested PR feedback, push updates, then comment `/agent run` to resume.";
  }
  if (normalized === "not_approved") {
    return "Request approval on the PR, then comment `/agent run` after approval.";
  }
  if (normalized === "no_merge_method_enabled") {
    return "Enable at least one merge method in the repository settings, then comment `/agent run`.";
  }
  return "Check PR merge conditions, fix blockers if needed, then comment `/agent run` to retry.";
}

export function buildReviewFollowupWaitingComment(options: {
  reason: string;
  queuedEngineFollowups: number;
  updatedAtIso?: string;
}): string {
  const updatedAt = options.updatedAtIso ?? new Date().toISOString();
  return buildAgentComment(
    [
      "Review follow-up is queued and waiting for an available idle engine.",
      "",
      "State: waiting",
      "Action: No action required right now.",
      `Reason: ${options.reason}`,
      `queued follow-ups requiring engine: ${options.queuedEngineFollowups}`,
      `Updated: ${updatedAt}`
    ].join("\n"),
    [REVIEW_FOLLOWUP_WAITING_MARKER]
  );
}

export function buildReviewFollowupActionRequiredComment(options: {
  reason: string;
  updatedAtIso?: string;
}): string {
  const updatedAt = options.updatedAtIso ?? new Date().toISOString();
  return buildAgentComment(
    [
      "Review follow-up could not continue automatically.",
      "",
      "State: Action required",
      `Action: ${buildManualActionGuidance(options.reason)}`,
      `Reason: ${options.reason}`,
      `Updated: ${updatedAt}`
    ].join("\n"),
    [REVIEW_FOLLOWUP_ACTION_REQUIRED_MARKER]
  );
}

export function shouldPostReviewFollowupMarkerComment(
  comments: IssueComment[],
  marker: string
): boolean {
  const latest = findLastMarkerComment(comments, marker);
  if (!latest) {
    return true;
  }
  return hasUserReplySince(comments, marker);
}
