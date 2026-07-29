/**
 * errors.ts - Custom error types with MCP-friendly error codes
 *
 * All errors thrown within the database layer should use these classes
 * so the index.ts tool handlers can produce consistent, user-friendly
 * error responses with actionable guidance.
 */

/** Error severity for logging */
export type ErrorSeverity = "info" | "warn" | "error";

export interface McpErrorOptions {
  /** Machine-readable error code */
  code: string;
  /** Human-readable explanation */
  message: string;
  /** Whether the client should retry the same request */
  retriable: boolean;
  /** Severity for logging */
  severity: ErrorSeverity;
  /** Optional hint on how to fix the error */
  hint?: string;
  /** Underlying cause */
  cause?: unknown;
}

/** Base class for all MCP database errors */
export abstract class McpError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly severity: ErrorSeverity;
  readonly hint?: string;
  readonly cause?: unknown;

  constructor(opts: McpErrorOptions) {
    super(opts.message);
    this.name = this.constructor.name;
    this.code = opts.code;
    this.retriable = opts.retriable;
    this.severity = opts.severity;
    this.hint = opts.hint;
    this.cause = opts.cause;
  }

  /** Format the error for MCP text content */
  toText(): string {
    const parts = [this.message];
    if (this.hint) parts.push("", "Hint: " + this.hint);
    parts.push("", `Error code: ${this.code}`);
    return parts.join("\n");
  }
}

/** Connection-related failures (pool exhausted, network down, auth failed) */
export class ConnectionError extends McpError {
  constructor(message: string, opts?: Partial<McpErrorOptions>) {
    super({
      code: opts?.code ?? "CONNECTION_ERROR",
      message,
      retriable: opts?.retriable ?? true,
      severity: opts?.severity ?? "error",
      hint: opts?.hint ??
        "Use db_health_check to verify the Oracle connection is working.",
      cause: opts?.cause,
    });
  }
}

/** SQL query execution failures (syntax error, table not found, etc.) */
export class QueryError extends McpError {
  constructor(message: string, opts?: Partial<McpErrorOptions>) {
    super({
      code: opts?.code ?? "QUERY_ERROR",
      message,
      retriable: opts?.retriable ?? false,
      severity: opts?.severity ?? "warn",
      hint: opts?.hint ??
        "Use db_list_tables and db_describe_table to verify schema before querying.",
      cause: opts?.cause,
    });
  }
}

/** Input validation failures (bad identifier, missing required field) */
export class ValidationError extends McpError {
  constructor(message: string, opts?: Partial<McpErrorOptions>) {
    super({
      code: opts?.code ?? "VALIDATION_ERROR",
      message,
      retriable: opts?.retriable ?? false,
      severity: opts?.severity ?? "info",
      hint: opts?.hint ?? "Check the input parameters and try again.",
      cause: opts?.cause,
    });
  }
}

/** Query exceeded the configured timeout */
export class TimeoutError extends McpError {
  constructor(timeoutMs: number) {
    super({
      code: "QUERY_TIMEOUT",
      message: `Query timed out after ${timeoutMs / 1000} seconds.`,
      retriable: true,
      severity: "warn",
      hint:
        "Add a tighter WHERE clause or optimize the query. " +
        "Increase QUERY_TIMEOUT_MS if the query legitimately needs more time.",
    });
  }
}

/** Rate limit exceeded */
export class RateLimitError extends McpError {
  constructor(maxPerMinute: number) {
    super({
      code: "RATE_LIMIT_EXCEEDED",
      message: `Rate limit exceeded: maximum ${maxPerMinute} requests per minute.`,
      retriable: true,
      severity: "warn",
      hint:
        "Wait a moment and retry. " +
        "Adjust RATE_LIMIT_PER_MINUTE if this limit is too low.",
    });
  }
}

/** Access denied — table blocked by whitelist/blacklist config */
export class AccessDeniedError extends McpError {
  constructor(tableName: string, reason: string) {
    super({
      code: "ACCESS_DENIED",
      message: `Access denied for table '${tableName}': ${reason}`,
      retriable: false,
      severity: "warn",
      hint:
        "Adjust ALLOWED_TABLES or BLOCKED_TABLES in the server configuration.",
    });
  }
}

/** DML blocked because the server is in read-only mode */
export class ReadOnlyModeError extends McpError {
  constructor() {
    super({
      code: "READ_ONLY_MODE",
      message: "This server is running in read-only mode. DML operations (INSERT/UPDATE/DELETE) are blocked.",
      retriable: false,
      severity: "info",
      hint: "Set READ_ONLY_MODE=false to enable write operations.",
    });
  }
}

/** DML would affect too many rows (safety cap exceeded) */
export class TooManyRowsError extends McpError {
  constructor(actual: number, limit: number) {
    super({
      code: "TOO_MANY_ROWS",
      message: `Operation would affect ${actual} row(s), exceeding the safety limit of ${limit}.`,
      retriable: false,
      severity: "warn",
      hint:
        "Add a more specific WHERE clause to limit the affected rows. " +
        "Adjust DML_MAX_ROWS if this is intentional.",
    });
  }
}

/**
 * Try to extract an Oracle error code from an oracledb error.
 * Oracle errors look like ORA-00942, ORA-01017, etc.
 */
export function extractOracleErrorCode(error: unknown): string | null {
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    // oracledb puts errorNum on the error object
    if (typeof err.errorNum === "number") {
      return `ORA-${err.errorNum}`;
    }
    // Some versions use .code
    if (typeof err.code === "string" && err.code.startsWith("ORA-")) {
      return err.code;
    }
    // Or the message itself starts with ORA-
    if (err.message && typeof err.message === "string") {
      const match = err.message.match(/(ORA-\d+)/);
      if (match) return match[1];
    }
  }
  return null;
}

/** Check if an error represents a connection-level failure worth retrying */
export function isTransientError(error: unknown): boolean {
  const code = extractOracleErrorCode(error);
  if (!code) return false;
  // ORA-03113/03114: connection closed
  // ORA-03135: connection lost contact
  // ORA-12500-12571: TNS/network errors
  // ORA-01089: immediate shutdown in progress
  // ORA-00054: resource busy (lock timeout) — might resolve shortly
  return [
    "ORA-03113", "ORA-03114", "ORA-03135",
    "ORA-12500", "ORA-12500", "ORA-12514", "ORA-12516", "ORA-12520",
    "ORA-12537", "ORA-12541", "ORA-12543", "ORA-12560", "ORA-12571",
    "ORA-01089", "ORA-00054",
  ].includes(code);
}

/** Wrap any unknown error into a McpError for consistent handling */
export function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;

  const oracleCode = extractOracleErrorCode(error);
  const message =
    error instanceof Error ? error.message : String(error);

  if (oracleCode && isTransientError(error)) {
    return new ConnectionError(
      `Oracle connection error (${oracleCode}): ${message}`,
      { code: oracleCode, cause: error }
    );
  }

  if (oracleCode) {
    return new QueryError(
      `Oracle error (${oracleCode}): ${message}`,
      { code: oracleCode, cause: error }
    );
  }

  return new QueryError(message, { cause: error });
}
