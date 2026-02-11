import { reviewFeedbackIndicatesOk } from "./review-feedback.js";
export type MergeMethod = "squash" | "merge" | "rebase";

export function chooseMergeMethod(options: {
  allowSquashMerge: boolean;
  allowMergeCommit: boolean;
  allowRebaseMerge: boolean;
}): MergeMethod | null {
  if (options.allowSquashMerge) return "squash";
  if (options.allowMergeCommit) return "merge";
  if (options.allowRebaseMerge) return "rebase";
  return null;
}

export type PullRequestReviewLite = {
  state: string;
  submittedAt: string | null;
  author: string | null;
  body?: string | null;
};

export type ReviewSummary = {
  approvals: number;
  changesRequested: number;
  actionableComments: number;
  okComments: number;
  pendingReviewers: number;
  reviewerCount: number;
  approved: boolean;
};

function normalizeReviewState(state: string): string {
  return state.trim().toUpperCase();
}

function parseSubmittedAt(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

type ReviewerStatus = "approved" | "changes_requested" | "commented_ok" | "commented_actionable";

function statusFromReview(review: PullRequestReviewLite): ReviewerStatus | null {
  const state = normalizeReviewState(review.state);
  if (state === "APPROVED") {
    return "approved";
  }
  if (state === "CHANGES_REQUESTED") {
    return "changes_requested";
  }
  if (state === "COMMENTED") {
    return reviewFeedbackIndicatesOk(review.body ?? null) ? "commented_ok" : "commented_actionable";
  }
  return null;
}

export function summarizeLatestReviews(
  reviews: PullRequestReviewLite[],
  requestedReviewers: string[] = []
): ReviewSummary {
  const byAuthor = new Map<string, { submittedAt: number; status: ReviewerStatus }>();

  for (const review of reviews) {
    if (!review.author) continue;
    const status = statusFromReview(review);
    if (!status) {
      continue;
    }

    const submittedAt = parseSubmittedAt(review.submittedAt);
    const key = review.author.toLowerCase();
    const existing = byAuthor.get(key);
    if (!existing || submittedAt >= existing.submittedAt) {
      byAuthor.set(key, { submittedAt, status });
    }
  }

  let approvals = 0;
  let changesRequested = 0;
  let actionableComments = 0;
  let okComments = 0;
  const required = new Set<string>(
    requestedReviewers.map(reviewer => reviewer.trim().toLowerCase()).filter(reviewer => reviewer.length > 0)
  );
  for (const reviewer of byAuthor.keys()) {
    required.add(reviewer);
  }

  for (const reviewer of required) {
    const entry = byAuthor.get(reviewer);
    if (!entry) {
      continue;
    }
    if (entry.status === "changes_requested") {
      changesRequested += 1;
      continue;
    }
    if (entry.status === "commented_actionable") {
      actionableComments += 1;
      continue;
    }
    if (entry.status === "approved") {
      approvals += 1;
      continue;
    }
    okComments += 1;
  }

  const pendingReviewers = Array.from(required.values()).filter(reviewer => !byAuthor.has(reviewer)).length;
  const reviewerCount = required.size;
  const hasPositiveSignal = approvals + okComments > 0;

  return {
    approvals,
    changesRequested,
    actionableComments,
    okComments,
    pendingReviewers,
    reviewerCount,
    approved:
      reviewerCount > 0 &&
      pendingReviewers === 0 &&
      changesRequested === 0 &&
      actionableComments === 0 &&
      hasPositiveSignal
  };
}
