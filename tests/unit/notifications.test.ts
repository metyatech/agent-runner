import { describe, expect, it } from "vitest";
import type { IssueComment } from "../../src/github.js";
import {
  AGENT_RUNNER_MARKER,
  NEEDS_USER_MARKER,
  buildAgentComment,
  hasUserReplySince
} from "../../src/notifications.js";

describe("notifications", () => {
  it("adds agent marker to comments", () => {
    const body = buildAgentComment("hello");
    expect(body).toContain(AGENT_RUNNER_MARKER);
    expect(body).toContain("hello");
  });

  it("detects replies after needs-user marker", () => {
    const comments: IssueComment[] = [
      {
        id: 1,
        body: buildAgentComment("failed", [NEEDS_USER_MARKER]),
        createdAt: "2026-01-30T10:00:00Z"
      },
      {
        id: 2,
        body: "I'll fix the env.",
        createdAt: "2026-01-30T10:05:00Z"
      }
    ];
    expect(hasUserReplySince(comments, NEEDS_USER_MARKER)).toBe(true);
  });

  it("ignores replies before needs-user marker", () => {
    const comments: IssueComment[] = [
      {
        id: 1,
        body: "Earlier note.",
        createdAt: "2026-01-30T09:55:00Z"
      },
      {
        id: 2,
        body: buildAgentComment("failed", [NEEDS_USER_MARKER]),
        createdAt: "2026-01-30T10:00:00Z"
      }
    ];
    expect(hasUserReplySince(comments, NEEDS_USER_MARKER)).toBe(false);
  });
});
