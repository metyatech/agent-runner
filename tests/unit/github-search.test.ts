import { describe, expect, it } from "vitest";
import { GitHubClient } from "../../src/github.js";

describe("GitHubClient.searchOpenIssuesByLabelAcrossOwner", () => {
  it("builds query with exclude labels and parses repository_url", async () => {
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
                  html_url: "https://github.com/metyatech/demo/issues/123",
                  repository_url: "https://api.github.com/repos/metyatech/demo",
                  user: { login: "metyatech" },
                  labels: [{ name: "agent:request" }]
                }
              ]
            }
          };
        }
      }
    };

    const issues = await client.searchOpenIssuesByLabelAcrossOwner("metyatech", "agent:request", {
      excludeLabels: ["agent:queued", "agent:running"],
      perPage: 100,
      maxPages: 1
    });

    expect(seenQuery).toContain('user:metyatech is:issue state:open label:"agent:request"');
    expect(seenQuery).toContain('-label:"agent:queued"');
    expect(seenQuery).toContain('-label:"agent:running"');
    expect(issues).toHaveLength(1);
    expect(issues[0].repo.owner).toBe("metyatech");
    expect(issues[0].repo.repo).toBe("demo");
  });
});
