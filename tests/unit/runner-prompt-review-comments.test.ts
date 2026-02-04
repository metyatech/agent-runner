import { describe, expect, it } from "vitest";
import type { IssueComment, IssueInfo, RepoInfo } from "../../src/github.js";
import { buildIssueTaskText } from "../../src/runner.js";

describe("runner prompt includes PR review comments", () => {
  it("appends a PR review comments section", () => {
    const repo: RepoInfo = { owner: "metyatech", repo: "demo" };
    const issue: IssueInfo = {
      id: 123,
      number: 5,
      title: "PR",
      body: "Body",
      author: "agent-runner-bot[bot]",
      repo,
      labels: [],
      url: "https://github.com/metyatech/demo/pull/5"
    };
    const issueComments: IssueComment[] = [];
    const reviewComments = [
      {
        id: 9001,
        body: "Please update this.",
        createdAt: new Date().toISOString(),
        author: "metyatech"
      }
    ];

    const text = buildIssueTaskText(issue, issueComments, reviewComments as any);
    expect(text).toContain("PR review comments");
    expect(text).toContain("Please update this.");
  });
});

