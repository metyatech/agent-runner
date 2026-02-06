import { describe, expect, it } from "vitest";
import { reviewFeedbackIndicatesOk } from "../../src/review-feedback.js";

describe("review-feedback", () => {
  it("treats no-new-comments feedback as OK", () => {
    expect(reviewFeedbackIndicatesOk("Copilot reviewed the PR and generated no comments.")).toBe(true);
  });

  it("treats usage-limit feedback as OK", () => {
    expect(reviewFeedbackIndicatesOk("Usage limit reached. Unable to review at this time.")).toBe(true);
    expect(reviewFeedbackIndicatesOk("利用上限に達したためレビューできません。")).toBe(true);
  });

  it("treats actionable feedback as not OK", () => {
    expect(reviewFeedbackIndicatesOk("Please fix null checks in converter.py")).toBe(false);
  });
});

