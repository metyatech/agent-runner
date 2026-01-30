export type LogLevel = "info" | "warn" | "error";

function safeWrite(line: string): void {
  try {
    process.stdout.write(line);
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      const code = (error as { code?: string }).code;
      if (code === "EPIPE") {
        return;
      }
    }
    throw error;
  }
}

export function log(level: LogLevel, message: string, json: boolean, data?: Record<string, unknown>): void {
  if (json) {
    const payload = {
      level,
      message,
      ...data,
      timestamp: new Date().toISOString()
    };
    safeWrite(`${JSON.stringify(payload)}\n`);
    return;
  }

  const details = data ? ` ${JSON.stringify(data)}` : "";
  safeWrite(`[${level.toUpperCase()}] ${message}${details}\n`);
}
