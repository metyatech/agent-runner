import { describe, expect, it } from "vitest";
import { parseIssueBody, parseRepoList } from "../../src/issue.js";

const body = `### Goal
Add CSV export

### Scope
Multiple repositories (list below)

### Repository list (if applicable)
qti-reporter, qti-xml-core

### Constraints
Keep dependencies minimal

### Autonomy
- [x] Yes, proceed autonomously

### Acceptance criteria
CLI supports --format csv`;

describe("parseIssueBody", () => {
  it("extracts sections", () => {
    const parsed = parseIssueBody(body);
    expect(parsed.goal).toBe("Add CSV export");
    expect(parsed.scope).toContain("Multiple repositories");
    expect(parsed.repoList).toEqual(["qti-reporter", "qti-xml-core"]);
    expect(parsed.constraints).toBe("Keep dependencies minimal");
    expect(parsed.acceptance).toBe("CLI supports --format csv");
  });
});

describe("parseRepoList", () => {
  it("handles empty input", () => {
    expect(parseRepoList("")).toEqual([]);
  });

  it("deduplicates entries", () => {
    expect(parseRepoList("a, b\na")).toEqual(["a", "b"]);
  });
});
