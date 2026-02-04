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
};

export type ReviewSummary = {
  approvals: number;
  changesRequested: boolean;
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

export function summarizeLatestReviews(reviews: PullRequestReviewLite[]): ReviewSummary {
  const byAuthor = new Map<string, { submittedAt: number; state: string }>();

  for (const review of reviews) {
    if (!review.author) continue;
    const state = normalizeReviewState(review.state);
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") {
      continue;
    }

    const submittedAt = parseSubmittedAt(review.submittedAt);
    const key = review.author.toLowerCase();
    const existing = byAuthor.get(key);
    if (!existing || submittedAt >= existing.submittedAt) {
      byAuthor.set(key, { submittedAt, state });
    }
  }

  let approvals = 0;
  let changesRequested = false;
  for (const entry of byAuthor.values()) {
    if (entry.state === "CHANGES_REQUESTED") {
      changesRequested = true;
    } else if (entry.state === "APPROVED") {
      approvals += 1;
    }
  }

  return {
    approvals,
    changesRequested,
    approved: approvals > 0 && !changesRequested
  };
}

