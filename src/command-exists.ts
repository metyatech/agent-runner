import { spawn } from "node:child_process";

export async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    const check = spawn(lookupCommand, [command], { stdio: "ignore" });

    check.on("error", () => {
      const fallback = spawn(command, ["--version"], { stdio: "ignore" });
      fallback.on("error", () => resolve(false));
      fallback.on("close", (code) => resolve(code === 0));
    });

    check.on("close", (code) => resolve(code === 0));
  });
}
