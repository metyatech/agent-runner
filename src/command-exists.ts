import { spawn } from "node:child_process";

export async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn(command, ["--version"], { shell: true });
    check.on("error", () => resolve(false));
    check.on("close", (code) => resolve(code === 0));
  });
}
