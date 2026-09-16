/**
 * One-line structured logs for the run server: pretty on a terminal, JSON lines when piped or LOG_FORMAT=json,
 * so a hosted process (the Docker image on App Platform) ships them to its log collector unchanged.
 * Previous hop: main.ts creates one logger; server.ts turns run events into lines. Never logs tokens or file contents.
 */
export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const LEVEL_TAG: Record<LogLevel, string> = { info: "info ", warn: "WARN ", error: "ERROR" };

export function createLogger(options: { format?: "pretty" | "json"; write?: (line: string) => void } = {}): Logger {
  const format = options.format ?? (process.env.LOG_FORMAT === "json" || !process.stdout.isTTY ? "json" : "pretty");
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const emit = (level: LogLevel, message: string, fields: Record<string, unknown> = {}): void => {
    const time = new Date().toISOString();
    if (format === "json") {
      write(JSON.stringify({ time, level, message, ...fields }));
      return;
    }
    const rest = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    write(`${time.slice(11, 19)} ${LEVEL_TAG[level]} ${message}${rest ? "  " + rest : ""}`);
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields)
  };
}
