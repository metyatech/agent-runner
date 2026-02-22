import { describe, expect, it } from "vitest";
import { ensureCodexManagerPrefix } from "../../src/runner.js";

describe("ensureCodexManagerPrefix", () => {
  it("prefixes $manager for codex engine", () => {
    const prompt = "You are running an autonomous task.";
    const result = ensureCodexManagerPrefix(prompt, "codex");
    expect(result.startsWith("$manager\n")).toBe(true);
    expect(result).toContain("Delegated mode");
    expect(result).toContain(prompt);
  });

  it("does not change prompts for non-codex engines", () => {
    const prompt = "Prompt";
    expect(ensureCodexManagerPrefix(prompt, "gemini-pro")).toBe(prompt);
    expect(ensureCodexManagerPrefix(prompt, "copilot")).toBe(prompt);
    expect(ensureCodexManagerPrefix(prompt, "claude")).toBe(prompt);
  });

  it("does not double-prefix when prompt already starts with $manager", () => {
    const prompt = "   $manager\nDo a thing.";
    expect(ensureCodexManagerPrefix(prompt, "codex")).toBe(prompt);
  });
});
