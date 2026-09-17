/** Every info/warn/error line also lands in a ring that GET /api/logs serves; debug lines are printed but never kept, which keeps refused requests out of the operator log. */
import type { ILoggerComponent } from "@well-known-components/interfaces";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  time: string;
  level: LogLevel;
  logger: string;
  message: string;
  fields: Record<string, string | number>;
}

export interface AppLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface ILogBufferComponent extends ILoggerComponent {
  /** The most recent kept lines, oldest first; `since` (ISO time) drops what the caller already has. */
  recent(limit?: number, since?: string): LogEntry[];
}

// enough for a day of quiet operation or a few busy hours; the host's log collector keeps the rest
export const RECENT_LINES = 2000;

/** WKC loggers take strings and numbers only; everything the server logs (booleans, verdicts, undefined) is flattened here. */
export function logFields(fields: Record<string, unknown> = {}): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = typeof value === "string" || typeof value === "number" ? value : typeof value === "boolean" || value === null ? String(value) : JSON.stringify(value);
  }
  return out;
}

export function appLogger(logs: ILoggerComponent, name: string): AppLogger {
  const logger = logs.getLogger(name);
  return {
    debug: (message, fields) => logger.debug(message, logFields(fields)),
    info: (message, fields) => logger.info(message, logFields(fields)),
    warn: (message, fields) => logger.warn(message, logFields(fields)),
    error: (message, fields) => logger.error(message, logFields(fields))
  };
}

export function createLogBufferComponent(components: { logs: ILoggerComponent }): ILogBufferComponent {
  const recent: LogEntry[] = [];

  function keep(level: LogLevel, logger: string, message: string, fields?: Record<string, string | number>): void {
    recent.push({ time: new Date().toISOString(), level, logger, message, fields: fields ?? {} });
    if (recent.length > RECENT_LINES) recent.shift();
  }

  return {
    getLogger(name) {
      const inner = components.logs.getLogger(name);
      return {
        log: (message, extra) => {
          keep("info", name, message, extra);
          inner.log(message, extra);
        },
        debug: (message, extra) => inner.debug(message, extra),
        info: (message, extra) => {
          keep("info", name, message, extra);
          inner.info(message, extra);
        },
        warn: (message, extra) => {
          keep("warn", name, message, extra);
          inner.warn(message, extra);
        },
        error: (error, extra) => {
          keep("error", name, error instanceof Error ? error.message : error, extra);
          inner.error(error, extra);
        }
      };
    },
    recent: (limit = 200, since) => {
      const lines = recent.slice(-Math.max(0, Math.min(limit, RECENT_LINES)));
      return since ? lines.filter((entry) => entry.time > since) : lines;
    }
  };
}
