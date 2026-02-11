import { spawn } from "node:child_process";

export type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type RunCommandResult = {
  stdout: string;
  stderr: string;
};

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error(`Timed out running: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", chunk => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", code => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const message = `Command failed (${code}): ${command} ${args.join(" ")}\n${stderr || stdout}`.trim();
      reject(new Error(message));
    });
  });
}
