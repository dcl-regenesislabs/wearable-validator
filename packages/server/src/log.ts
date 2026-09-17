/**
 * One-line structured logs for the run server: pretty on a terminal, JSON lines when piped or LOG_FORMAT=json,
 * so a hosted process (the Docker image on App Platform) ships them to its log collector unchanged.
 * Previous hop: main.ts creates one logger; server.ts turns run events into lines. Never logs tokens or file contents.
 */
export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  time: string;
  level: LogLevel;
  message: string;
  fields: Record<string, unknown>;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** The most recent lines, oldest first, for operators asking the API what happened. */
  recent?(limit?: number): LogEntry[];
}

// enough for a day of quiet operation or a few busy hours; the host's log collector keeps the rest
const RECENT_LINES = 2000;

const LEVEL_TAG: Record<LogLevel, string> = { info: "info ", warn: "WARN ", error: "ERROR" };

export function createLogger(options: { format?: "pretty" | "json"; write?: (line: string) => void } = {}): Logger {
  const format = options.format ?? (process.env.LOG_FORMAT === "json" || !process.stdout.isTTY ? "json" : "pretty");
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const recent: LogEntry[] = [];
  const emit = (level: LogLevel, message: string, fields: Record<string, unknown> = {}): void => {
    const time = new Date().toISOString();
    recent.push({ time, level, message, fields });
    if (recent.length > RECENT_LINES) recent.shift();
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
    error: (message, fields) => emit("error", message, fields),
    recent: (limit = 200) => recent.slice(-Math.max(0, Math.min(limit, RECENT_LINES)))
  };
}
