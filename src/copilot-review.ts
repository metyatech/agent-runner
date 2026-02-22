import type { PullRequestReview } from "./github.js";
import { reviewFeedbackIndicatesOk } from "./review-feedback.js";

const COPILOT_REVIEWER_LOGINS = new Set([
  "copilot",
  "copilot-pull-request-reviewer",
  "github-copilot[bot]",
  "copilot[bot]"
]);

export function isCopilotReviewerLogin(login: string | null): boolean {
  if (!login) return false;
  const normalized = login.trim().toLowerCase();
  if (!normalized) return false;
  if (COPILOT_REVIEWER_LOGINS.has(normalized)) return true;
  return (
    normalized.includes("copilot") &&
    (normalized.endsWith("[bot]") || normalized.includes("pull-request-reviewer"))
  );
}

export function copilotReviewIndicatesNoNewComments(body: string | null): boolean {
  return reviewFeedbackIndicatesOk(body);
}

function parseSubmittedAt(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function latestCopilotReview(reviews: PullRequestReview[]): PullRequestReview | null {
  const candidates = reviews.filter((review) => isCopilotReviewerLogin(review.author ?? null));
  if (candidates.length === 0) return null;
  let latest = candidates[0]!;
  for (const review of candidates.slice(1)) {
    const a = parseSubmittedAt(latest.submittedAt);
    const b = parseSubmittedAt(review.submittedAt);
    if (b > a) {
      latest = review;
      continue;
    }
    if (b === a && review.id > latest.id) {
      latest = review;
    }
  }
  return latest;
}

export function copilotLatestReviewIsNoNewCommentsApproval(reviews: PullRequestReview[]): boolean {
  const review = latestCopilotReview(reviews);
  if (!review) return false;
  if (review.state.trim().toUpperCase() !== "COMMENTED") return false;
  return copilotReviewIndicatesNoNewComments(review.body ?? null);
}
