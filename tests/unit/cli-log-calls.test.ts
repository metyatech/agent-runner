import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");
}

describe("cli log call style", () => {
  it("does not use undefined placeholders just to pass tag arguments", () => {
    const cliSource = readRepoFile("src", "cli.ts");
    const undefinedTagPattern = /undefined,\s*"[\w-]+"/g;

    expect(cliSource).not.toMatch(undefinedTagPattern);
  });
});
