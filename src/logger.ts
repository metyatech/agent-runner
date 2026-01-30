export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, message: string, json: boolean, data?: Record<string, unknown>): void {
  if (json) {
    const payload = {
      level,
      message,
      ...data,
      timestamp: new Date().toISOString()
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  const details = data ? ` ${JSON.stringify(data)}` : "";
  process.stdout.write(`[${level.toUpperCase()}] ${message}${details}\n`);
}
