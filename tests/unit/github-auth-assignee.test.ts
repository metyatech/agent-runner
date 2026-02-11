import { describe, expect, it } from "vitest";
import { GitHubClient } from "../../src/github.js";

describe("GitHubClient.getAuthenticatedLogin", () => {
  it("returns authenticated user login", async () => {
    const client = new GitHubClient("dummy");
    (client as any).octokit = {
      users: {
        getAuthenticated: async () => ({
          data: { login: "alice" }
        })
      }
    };

    await expect(client.getAuthenticatedLogin()).resolves.toBe("alice");
  });
});

describe("GitHubClient.addAssignees", () => {
  it("filters empty assignees and calls issues.addAssignees", async () => {
    const client = new GitHubClient("dummy");
    let seen: any = null;
    (client as any).octokit = {
      issues: {
        addAssignees: async (params: any) => {
          seen = params;
          return { data: {} };
        }
      }
    };

    await client.addAssignees({ owner: "metyatech", repo: "demo" }, 123, ["alice", " ", "alice"]);

    expect(seen).toMatchObject({
      owner: "metyatech",
      repo: "demo",
      issue_number: 123,
      assignees: ["alice"]
    });
  });
});

describe("GitHubClient.findOpenPullRequestByHead", () => {
  it("passes owner:branch to pulls.list and returns the first PR", async () => {
    const client = new GitHubClient("dummy");
    let seen: any = null;
    (client as any).octokit = {
      pulls: {
        list: async (params: any) => {
          seen = params;
          return {
            data: [
              {
                number: 7,
                html_url: "https://github.com/metyatech/demo/pull/7"
              }
            ]
          };
        }
      }
    };

    await expect(
      client.findOpenPullRequestByHead({ owner: "metyatech", repo: "demo" }, "agent-runner/idle-codex-123")
    ).resolves.toEqual({
      number: 7,
      url: "https://github.com/metyatech/demo/pull/7"
    });

    expect(seen).toMatchObject({
      owner: "metyatech",
      repo: "demo",
      state: "open",
      head: "metyatech:agent-runner/idle-codex-123"
    });
  });
});

describe("GitHubClient.listOpenPullRequests", () => {
  it("lists open pull requests with updated-desc order", async () => {
    const client = new GitHubClient("dummy");
    let seen: any = null;
    (client as any).octokit = {
      pulls: {
        list: async (params: any) => {
          seen = params;
          return {
            data: [
              {
                number: 10,
                title: "Improve scheduler",
                body: "Refine idle selection.",
                html_url: "https://github.com/metyatech/demo/pull/10",
                updated_at: "2026-02-11T10:00:00Z",
                user: { login: "metyatech" }
              }
            ]
          };
        }
      }
    };

    const listed = await client.listOpenPullRequests({ owner: "metyatech", repo: "demo" });
    expect(listed).toEqual([
      {
        number: 10,
        title: "Improve scheduler",
        body: "Refine idle selection.",
        url: "https://github.com/metyatech/demo/pull/10",
        updatedAt: "2026-02-11T10:00:00Z",
        author: "metyatech"
      }
    ]);

    expect(seen).toMatchObject({
      owner: "metyatech",
      repo: "demo",
      state: "open",
      sort: "updated",
      direction: "desc"
    });
  });

  it("stops pagination once limit is reached", async () => {
    const client = new GitHubClient("dummy");
    const calls: any[] = [];
    (client as any).octokit = {
      pulls: {
        list: async (params: any) => {
          calls.push(params);
          return {
            data: [
              {
                number: 30,
                title: "A",
                body: "A",
                html_url: "https://github.com/metyatech/demo/pull/30",
                updated_at: "2026-02-11T10:00:00Z",
                user: { login: "alice" }
              },
              {
                number: 31,
                title: "B",
                body: "B",
                html_url: "https://github.com/metyatech/demo/pull/31",
                updated_at: "2026-02-11T09:00:00Z",
                user: { login: "bob" }
              }
            ]
          };
        }
      }
    };

    const listed = await client.listOpenPullRequests({ owner: "metyatech", repo: "demo" }, { limit: 1 });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.number).toBe(30);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      per_page: 1,
      page: 1
    });
  });

  it("keeps per_page constant across paginated requests", async () => {
    const client = new GitHubClient("dummy");
    const calls: any[] = [];
    (client as any).octokit = {
      pulls: {
        list: async (params: any) => {
          calls.push(params);
          if (params.page === 1) {
            return {
              data: Array.from({ length: 100 }, (_v, index) => ({
                number: index + 1,
                title: `PR-${index + 1}`,
                body: null,
                html_url: `https://github.com/metyatech/demo/pull/${index + 1}`,
                updated_at: "2026-02-11T10:00:00Z",
                user: { login: "alice" }
              }))
            };
          }
          return {
            data: Array.from({ length: 100 }, (_v, index) => ({
              number: index + 101,
              title: `PR-${index + 101}`,
              body: null,
              html_url: `https://github.com/metyatech/demo/pull/${index + 101}`,
              updated_at: "2026-02-11T09:00:00Z",
              user: { login: "alice" }
            }))
          };
        }
      }
    };

    const listed = await client.listOpenPullRequests({ owner: "metyatech", repo: "demo" }, { limit: 150 });
    expect(listed).toHaveLength(150);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.per_page).toBe(100);
    expect(calls[1]?.per_page).toBe(100);
  });

  it("throws for non-finite limit and returns empty for non-positive limit", async () => {
    const client = new GitHubClient("dummy");
    const calls: any[] = [];
    (client as any).octokit = {
      pulls: {
        list: async (params: any) => {
          calls.push(params);
          return { data: [] };
        }
      }
    };

    await expect(
      client.listOpenPullRequests({ owner: "metyatech", repo: "demo" }, { limit: Number.NaN })
    ).rejects.toThrow(/Invalid limit/);
    await expect(
      client.listOpenPullRequests({ owner: "metyatech", repo: "demo" }, { limit: 0 })
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("skips items without typed number and non-empty URL", async () => {
    const client = new GitHubClient("dummy");
    (client as any).octokit = {
      pulls: {
        list: async () => ({
          data: [
            {
              number: "9",
              title: "invalid-number",
              body: "x",
              html_url: "https://github.com/metyatech/demo/pull/9",
              updated_at: "2026-02-11T10:00:00Z",
              user: { login: "alice" }
            },
            {
              number: 10,
              title: "invalid-url-empty",
              body: "x",
              html_url: "",
              updated_at: "2026-02-11T09:59:00Z",
              user: { login: "alice" }
            },
            {
              number: 11,
              title: "invalid-url-null",
              body: "x",
              html_url: null,
              updated_at: "2026-02-11T09:58:00Z",
              user: { login: "alice" }
            },
            {
              number: 12,
              title: "valid",
              body: "ok",
              html_url: "https://github.com/metyatech/demo/pull/12",
              updated_at: "2026-02-11T09:57:00Z",
              user: { login: "alice" }
            }
          ]
        })
      }
    };

    const listed = await client.listOpenPullRequests({ owner: "metyatech", repo: "demo" }, { limit: 20 });
    expect(listed).toEqual([
      {
        number: 12,
        title: "valid",
        body: "ok",
        url: "https://github.com/metyatech/demo/pull/12",
        updatedAt: "2026-02-11T09:57:00Z",
        author: "alice"
      }
    ]);
  });
});

describe("GitHubClient.getOpenPullRequestCount", () => {
  it("reads open PR total count from GraphQL", async () => {
    const client = new GitHubClient("dummy");
    let seen: any = null;
    (client as any).octokit = {
      request: async (route: string, params: any) => {
        seen = { route, params };
        return {
          data: {
            repository: {
              pullRequests: {
                totalCount: 123
              }
            }
          }
        };
      }
    };

    await expect(client.getOpenPullRequestCount({ owner: "metyatech", repo: "demo" })).resolves.toBe(123);
    expect(seen.route).toBe("POST /graphql");
    expect(seen.params.owner).toBe("metyatech");
    expect(seen.params.name).toBe("demo");
  });
});
