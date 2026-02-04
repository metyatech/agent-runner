import { describe, expect, it } from "vitest";
import { GitHubClient } from "../../src/github.js";

describe("GitHubClient.searchOpenItemsByLabelAcrossOwner", () => {
  it("builds query without restricting to issues", async () => {
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
                  id: 1,
                  number: 123,
                  title: "Test",
                  body: "Body",
                  html_url: "https://github.com/metyatech/demo/pull/123",
                  repository_url: "https://api.github.com/repos/metyatech/demo",
                  user: { login: "metyatech" },
                  labels: [{ name: "agent:request" }],
                  pull_request: { url: "https://api.github.com/repos/metyatech/demo/pulls/123" }
                }
              ]
            }
          };
        }
      }
    };

    const items = await client.searchOpenItemsByLabelAcrossOwner("metyatech", "agent:request", {
      excludeLabels: ["agent:queued"],
      perPage: 100,
      maxPages: 1
    });

    expect(seenQuery).toContain('user:metyatech state:open label:"agent:request"');
    expect(seenQuery).toContain('-label:"agent:queued"');
    expect(seenQuery).not.toContain("type:issue");
    expect(items).toHaveLength(1);
    expect(items[0].repo.owner).toBe("metyatech");
    expect(items[0].repo.repo).toBe("demo");
  });
});

describe("GitHubClient.searchOpenItemsByCommentPhraseAcrossOwner", () => {
  it("builds query with in:comments and parses repository_url", async () => {
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
                  id: 2,
                  number: 456,
                  title: "Test 2",
                  body: "Body",
                  html_url: "https://github.com/metyatech/demo/issues/456",
                  repository_url: "https://api.github.com/repos/metyatech/demo",
                  user: { login: "metyatech" },
                  labels: []
                }
              ]
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

    expect(seenQuery).toContain('user:metyatech state:open in:comments "/agent run"');
    expect(seenQuery).toContain('-label:"agent:done"');
    expect(items).toHaveLength(1);
    expect(items[0].repo.owner).toBe("metyatech");
    expect(items[0].repo.repo).toBe("demo");
  });
});

