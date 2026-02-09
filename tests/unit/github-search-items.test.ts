import { describe, expect, it } from "vitest";
import { GitHubClient } from "../../src/github.js";

describe("GitHubClient.searchOpenItemsByLabelAcrossOwner", () => {
  it("adds is:issue / is:pull-request qualifiers and merges results", async () => {
    const client = new GitHubClient("dummy");
    const seenQueries: string[] = [];
    (client as any).octokit = {
      search: {
        issuesAndPullRequests: async ({ q }: { q: string }) => {
          seenQueries.push(q);
          const qualifier = q.includes("is:pull-request") ? "pr" : q.includes("is:issue") ? "issue" : "unknown";
          return {
            data: {
              items:
                qualifier === "issue"
                  ? [
                      {
                        id: 1,
                        number: 123,
                        title: "Issue",
                        body: "Body",
                        html_url: "https://github.com/metyatech/demo/issues/123",
                        repository_url: "https://api.github.com/repos/metyatech/demo",
                        user: { login: "metyatech" },
                        labels: [{ name: "agent:queued" }]
                      }
                    ]
                  : qualifier === "pr"
                  ? [
                      {
                        id: 2,
                        number: 456,
                        title: "PR",
                        body: "Body",
                        html_url: "https://github.com/metyatech/demo/pull/456",
                        repository_url: "https://api.github.com/repos/metyatech/demo",
                        user: { login: "metyatech" },
                        labels: [{ name: "agent:queued" }],
                        pull_request: { url: "https://api.github.com/repos/metyatech/demo/pulls/456" }
                      }
                    ]
                  : []
            }
          };
        }
      }
    };

    const items = await client.searchOpenItemsByLabelAcrossOwner("metyatech", "agent:queued", {
      excludeLabels: ["agent:queued"],
      perPage: 100,
      maxPages: 1
    });

    expect(seenQueries).toHaveLength(2);
    expect(seenQueries[0]).toContain('user:metyatech state:open label:"agent:queued"');
    expect(seenQueries[0]).toContain('-label:"agent:queued"');
    expect(seenQueries.join("\n")).toContain("is:issue");
    expect(seenQueries.join("\n")).toContain("is:pull-request");
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.number).sort()).toEqual([123, 456]);
    expect(items.find((item) => item.number === 123)?.isPullRequest).toBe(false);
    expect(items.find((item) => item.number === 456)?.isPullRequest).toBe(true);
  });
});

describe("GitHubClient.searchOpenItemsByCommentPhraseAcrossOwner", () => {
  it("adds is:issue / is:pull-request qualifiers and merges results", async () => {
    const client = new GitHubClient("dummy");
    const seenQueries: string[] = [];
    (client as any).octokit = {
      search: {
        issuesAndPullRequests: async ({ q }: { q: string }) => {
          seenQueries.push(q);
          const qualifier = q.includes("is:pull-request") ? "pr" : q.includes("is:issue") ? "issue" : "unknown";
          return {
            data: {
              items:
                qualifier === "issue"
                  ? [
                      {
                        id: 2,
                        number: 456,
                        title: "Issue 2",
                        body: "Body",
                        html_url: "https://github.com/metyatech/demo/issues/456",
                        repository_url: "https://api.github.com/repos/metyatech/demo",
                        user: { login: "metyatech" },
                        labels: []
                      }
                    ]
                  : qualifier === "pr"
                  ? [
                      {
                        id: 3,
                        number: 789,
                        title: "PR 3",
                        body: "Body",
                        html_url: "https://github.com/metyatech/demo/pull/789",
                        repository_url: "https://api.github.com/repos/metyatech/demo",
                        user: { login: "metyatech" },
                        labels: [],
                        pull_request: { url: "https://api.github.com/repos/metyatech/demo/pulls/789" }
                      }
                    ]
                  : []
            }
          };
        }
      }
    };

    const items = await client.searchOpenItemsByCommentPhraseAcrossOwner("metyatech", "/agent run", {
      excludeLabels: ["agent:done"],
      perPage: 100,
      maxPages: 1
    });

    expect(seenQueries).toHaveLength(2);
    expect(seenQueries[0]).toContain('user:metyatech state:open in:comments "/agent run"');
    expect(seenQueries[0]).toContain('-label:"agent:done"');
    expect(seenQueries.join("\n")).toContain("is:issue");
    expect(seenQueries.join("\n")).toContain("is:pull-request");
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.number).sort()).toEqual([456, 789]);
    expect(items.find((item) => item.number === 456)?.isPullRequest).toBe(false);
    expect(items.find((item) => item.number === 789)?.isPullRequest).toBe(true);
  });
});

describe("GitHubClient.searchOpenPullRequestsByAuthorAcrossOwner", () => {
  it("builds query with author qualifier, exclude labels, and parses repository_url", async () => {
    const client = new GitHubClient("dummy");
    let seenQuery: string | null = null;
    (client as any).octokit = {
      search: {
        issuesAndPullRequests: async ({ q }: { q: string }) => {
          seenQuery = q;
          return {
            data: {
              items: [
                {
                  id: 10,
                  number: 123,
                  title: "PR",
                  body: "Body",
                  html_url: "https://github.com/metyatech/demo/pull/123",
                  repository_url: "https://api.github.com/repos/metyatech/demo",
                  user: { login: "app/agent-runner-bot" },
                  labels: [{ name: "agent:queued" }],
                  pull_request: { url: "https://api.github.com/repos/metyatech/demo/pulls/123" }
                }
              ]
            }
          };
        }
      }
    };

    const items = await client.searchOpenPullRequestsByAuthorAcrossOwner("metyatech", "app/agent-runner-bot", {
      excludeLabels: ["agent:queued", "agent:running"],
      perPage: 10,
      maxPages: 1
    });

    expect(seenQuery).toContain("user:metyatech state:open");
    expect(seenQuery).toContain('author:"app/agent-runner-bot"');
    expect(seenQuery).toContain("is:pr");
    expect(seenQuery).toContain('-label:"agent:queued"');
    expect(seenQuery).toContain('-label:"agent:running"');
    expect(items).toHaveLength(1);
    expect(items[0].repo).toEqual({ owner: "metyatech", repo: "demo" });
    expect(items[0].isPullRequest).toBe(true);
  });
});
