import { describe, expect, it } from "vitest";
import { buildIdleOpenPrContext } from "../../src/idle-open-pr-context.js";
import type { OpenPullRequestInfo } from "../../src/github.js";

describe("buildIdleOpenPrContext", () => {
  it("renders title and body summary for each open pull request", () => {
    const pulls: OpenPullRequestInfo[] = [
      {
        number: 21,
        title: "Refactor webhook queue",
        body: "This PR updates queue ordering and retry handling.",
        url: "https://github.com/metyatech/demo/pull/21",
        updatedAt: "2026-02-11T09:00:00Z",
        author: "metyatech"
      },
      {
        number: 22,
        title: "Improve docs",
        body: null,
        url: "https://github.com/metyatech/demo/pull/22",
        updatedAt: "2026-02-11T08:00:00Z",
        author: "alice"
      }
    ];

    const context = buildIdleOpenPrContext(pulls);

    expect(context).toContain("#21");
    expect(context).toContain("Refactor webhook queue");
    expect(context).toContain("queue ordering and retry handling");
    expect(context).toContain("#22");
    expect(context).toContain("Improve docs");
    expect(context).toContain("No description");
  });

  it("renders fallback when no open pull requests exist", () => {
    const context = buildIdleOpenPrContext([]);
    expect(context).toContain("No open pull requests");
  });
});
