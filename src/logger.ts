/**
 * logger.ts - Structured logging with levels, timestamps, and request context
 *
 * Supports JSON or text output, configurable levels, and per-request context
 * for tracing operations across the MCP request lifecycle.
 */

import { getConfig } from "./config.js";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

/** Request context attached to each log entry when available */
export interface RequestContext {
  /** Unique request ID for tracing (optional — internal operations may not have one) */
  requestId?: string;
  /** Tool name being called */
  tool?: string;
  /** Optional extra metadata */
  meta?: Record<string, unknown>;
}

/**
 * Logger class that writes to stderr (stdout is reserved for MCP stdio JSON-RPC).
 * Supports both JSON-structured and human-readable text formats.
 */
class Logger {
  private level: LogLevel;
  private json: boolean;

  constructor() {
    const config = getConfig();
    this.level = (config.log.level === "NONE" ? "ERROR" : config.log.level) as LogLevel;
    this.json = config.log.json;
  }

  /** Re-read config (useful if config changes at runtime) */
  refresh(): void {
    const config = getConfig();
    this.level = (config.log.level === "NONE" ? "ERROR" : config.log.level) as LogLevel;
    this.json = config.log.json;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  private write(
    level: LogLevel,
    message: string,
    context?: RequestContext
  ): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();

    if (this.json) {
      const entry: Record<string, unknown> = {
        ts: timestamp,
        level,
        msg: message,
      };
      if (context?.requestId) entry.requestId = context.requestId;
      if (context?.tool) entry.tool = context.tool;
      if (context?.meta) entry.meta = context.meta;
      process.stderr.write(JSON.stringify(entry) + "\n");
    } else {
      const prefix = `[${timestamp}] [${level}]`;
      const ctx = context?.requestId
        ? ` [${context.requestId}${context.tool ? ":" + context.tool : ""}]`
        : "";
      process.stderr.write(`${prefix}${ctx} ${message}\n`);
    }
  }

  debug(message: string, context?: RequestContext): void {
    this.write("DEBUG", message, context);
  }

  info(message: string, context?: RequestContext): void {
    this.write("INFO", message, context);
  }

  warn(message: string, context?: RequestContext): void {
    this.write("WARN", message, context);
  }

  error(
    message: string,
    error?: unknown,
    context?: RequestContext
  ): void {
    const errorStr = error
      ? `: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
      : "";
    this.write("ERROR", message + errorStr, context);
  }
}

// Singleton logger — initialized on first use
let loggerInstance: Logger | null = null;

export function getLogger(): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger();
  }
  return loggerInstance;
}

/** Generate a short unique request ID */
export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
