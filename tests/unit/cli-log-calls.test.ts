import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(...segments: string[]): string {
  // Normalize CRLF to LF so string searches with "\n" work on Windows CI
  return fs.readFileSync(path.join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

describe("cli log call style", () => {
  it("does not use undefined placeholders just to pass tag arguments", () => {
    const cliSource = readRepoFile("src", "cli.ts");
    const undefinedTagPattern = /undefined,\s*"[\w-]+"/g;

    expect(cliSource).not.toMatch(undefinedTagPattern);
  });
});

describe("handleRunFailure label cleanup (Bug 1)", () => {
  it("removes agent:done label in the quota failure path before adding agent:failed", () => {
    const cliSource = readRepoFile("src", "cli.ts");
    // Extract the handleRunFailure function body
    const handleRunFailureStart = cliSource.indexOf("const handleRunFailure = async");
    expect(handleRunFailureStart).toBeGreaterThan(-1);
    const handleRunFailureEnd = cliSource.indexOf("\n    };\n\n    const queueNewRequestsByAgentRunComment", handleRunFailureStart);
    expect(handleRunFailureEnd).toBeGreaterThan(-1);
    const fnBody = cliSource.slice(handleRunFailureStart, handleRunFailureEnd);

    // Verify the quota path removes done label
    const quotaPath = fnBody.slice(fnBody.indexOf('failureKind === "quota"'), fnBody.indexOf('failureKind === "needs_user_reply"'));
    expect(quotaPath).toContain('tryRemoveLabel(issue, config.labels.done)');

    // Verify the default (terminal) failure path removes done label
    const terminalPath = fnBody.slice(fnBody.lastIndexOf("clearIssueSession(issueSessionStatePath"));
    expect(terminalPath).toContain('tryRemoveLabel(issue, config.labels.done)');
  });
});

describe("tryRemoveLabel silences label-not-found errors (Bug 3)", () => {
  it("does not log WARN when the error status is 404", () => {
    const cliSource = readRepoFile("src", "cli.ts");
    const tryRemoveLabelStart = cliSource.indexOf("const tryRemoveLabel = async");
    expect(tryRemoveLabelStart).toBeGreaterThan(-1);
    // Find the closing of the function (next const declaration at same indent)
    const tryRemoveLabelEnd = cliSource.indexOf("\n    const tryRemoveReviewFollowupLabels", tryRemoveLabelStart);
    expect(tryRemoveLabelEnd).toBeGreaterThan(-1);
    const fnBody = cliSource.slice(tryRemoveLabelStart, tryRemoveLabelEnd);

    // Should handle 404 and 422 silently
    expect(fnBody).toContain("status === 404");
    expect(fnBody).toContain("status === 422");
    expect(fnBody).toContain('label does not exist');
  });
});
