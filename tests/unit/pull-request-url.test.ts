import { describe, expect, it } from "vitest";
import { parseLastPullRequestUrl } from "../../src/pull-request-url.js";

describe("pull-request-url", () => {
  it("returns null when no PR url is present", () => {
    expect(parseLastPullRequestUrl("no link")).toBe(null);
  });

  it("parses the last GitHub PR URL in text", () => {
    const text =
      "first https://github.com/metyatech/demo/pull/1 and then https://github.com/metyatech/demo/pull/42";
    expect(parseLastPullRequestUrl(text)).toEqual({
      repo: { owner: "metyatech", repo: "demo" },
      number: 42,
      url: "https://github.com/metyatech/demo/pull/42"
    });
  });
});
