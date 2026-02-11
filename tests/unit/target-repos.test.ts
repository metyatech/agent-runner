import { describe, expect, it } from "vitest";
import type { IssueInfo } from "../../src/github.js";
import { resolveTargetRepos } from "../../src/target-repos.js";

describe("resolveTargetRepos", () => {
  it("includes the issue repo and dedupes additional repos", () => {
    const issue: IssueInfo = {
      id: 1,
      number: 1,
      title: "Test",
      body: ["### Repository list (if applicable)", "", "demo, demo, other", ""].join("\n"),
      author: "metyatech",
      repo: { owner: "metyatech", repo: "demo" },
      labels: [],
      url: "https://github.com/metyatech/demo/issues/1",
      isPullRequest: false
    };

    const repos = resolveTargetRepos(issue, "metyatech");
    expect(repos.map(r => r.repo)).toEqual(["demo", "other"]);
  });
});
