import { describe, expect, it } from "vitest";
import { isAllowedAuthorAssociation, parseAgentCommand } from "../../src/agent-command.js";

describe("agent-command", () => {
  it("parses /agent run on its own line", () => {
    expect(parseAgentCommand("/agent run")?.kind).toBe("run");
  });

  it("parses /agent run with leading whitespace", () => {
    expect(parseAgentCommand("  /agent   run  ")?.kind).toBe("run");
  });

  it("parses /agent run when present later in the body", () => {
    const body = ["hello", "", "  /agent run --dry-run", "more"].join("\n");
    expect(parseAgentCommand(body)?.kind).toBe("run");
  });

  it("returns null when no command exists", () => {
    expect(parseAgentCommand("hello")).toBeNull();
  });

  it("validates allowed author associations", () => {
    expect(isAllowedAuthorAssociation("OWNER")).toBe(true);
    expect(isAllowedAuthorAssociation("member")).toBe(true);
    expect(isAllowedAuthorAssociation("COLLABORATOR")).toBe(true);
    expect(isAllowedAuthorAssociation("CONTRIBUTOR")).toBe(false);
    expect(isAllowedAuthorAssociation("NONE")).toBe(false);
    expect(isAllowedAuthorAssociation(null)).toBe(false);
  });
});
