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

export function log(level: LogLevel, message: string, json: boolean, data?: Record<string, unknown>, tag?: string): void {
  const timestamp = new Date().toISOString();
  if (json) {
    const payload: Record<string, unknown> = {
      level,
      ...(tag ? { tag } : {}),
      message,
      ...data,
      timestamp
    };
    safeWrite(`${JSON.stringify(payload)}\n`);
    return;
  }

  const tagPart = tag ? `[${tag}] ` : "";
  const details = data ? ` ${JSON.stringify(data)}` : "";
  safeWrite(`[${timestamp}] [${level.toUpperCase()}] ${tagPart}${message}${details}\n`);
}
