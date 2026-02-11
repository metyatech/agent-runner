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
});
