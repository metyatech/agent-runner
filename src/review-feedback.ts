const OK_REVIEW_PATTERNS: RegExp[] = [
  /\bgenerated\s+no(?:\s+new)?\s+comments?\b/i,
  /\bno\s+new\s+comments?\b/i,
  /\bno\s+issues?\s+found\b/i,
  /\blooks?\s+good\b/i,
  /\blgtm\b/i,
  /\bapproved\b/i,
  /\busage\s+limit\b/i,
  /\brate\s+limit\b/i,
  /\bquota\b/i,
  /\bunable\s+to\s+review\b/i,
  /\bcannot\s+review\b/i,
  /\bcan'?t\s+review\b/i,
  /利用上限/,
  /使用量上限/,
  /クォータ/,
  /上限/,
  /レビューできません/,
  /review\s+unavailable/i
];

export function reviewFeedbackIndicatesOk(body: string | null): boolean {
  const text = (body ?? "").trim();
  if (!text) {
    return true;
  }
  return OK_REVIEW_PATTERNS.some((pattern) => pattern.test(text));
}

