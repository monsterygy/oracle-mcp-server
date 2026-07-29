/**
 * config.ts - Centralized configuration management
 *
 * Reads all environment variables at startup, validates required fields,
 * and exposes a typed singleton config object used across the codebase.
 * No other module should read process.env directly.
 */

/** Log levels ordered by severity */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "NONE";

/** Oracle driver mode */
export type DriverMode = "thin" | "thick";

export interface AppConfig {
  /** Oracle connection */
  oracle: {
    user: string;
    password: string;
    connectString: string;
    /** Path to Oracle Instant Client library (thick mode only) */
    libDir?: string;
    /** Explicit TNS_ADMIN directory */
    tnsAdmin?: string;
    /** ORACLE_HOME (fallback for tnsnames.ora search) */
    oracleHome?: string;
  };

  /** Connection pool */
  pool: {
    min: number;
    max: number;
    increment: number;
    timeoutSec: number;
    pingIntervalSec: number;
    connectionTimeoutMs: number;
  };

  /** Query safety limits */
  limits: {
    maxRows: number;
    queryTimeoutMs: number;
    maxSqlLength: number;
    maxWhereLength: number;
    /** Safety cap: refuse UPDATE/DELETE that would affect more rows than this */
    maxDmlRows: number;
  };

  /** Rate limiting */
  rateLimit: {
    enabled: boolean;
    maxRequestsPerMinute: number;
  };

  /** Table access control */
  access: {
    /** Whitelist of allowed table names (uppercase). If empty, all non-system tables allowed. */
    allowedTables: string[];
    /** Blacklist of blocked table names (uppercase). */
    blockedTables: string[];
    /** If true, DML (INSERT/UPDATE/DELETE) is blocked entirely. */
    readOnly: boolean;
  };

  /** Logging */
  log: {
    level: LogLevel;
    /** If true, logs are JSON; if false, plain text */
    json: boolean;
  };

  /** Server metadata */
  server: {
    name: string;
    version: string;
  };
}

/** Parse a comma-separated string into an uppercase string array */
function parseTableList(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const upper = (raw ?? "INFO").toUpperCase();
  if (["DEBUG", "INFO", "WARN", "ERROR", "NONE"].includes(upper)) {
    return upper as LogLevel;
  }
  return "INFO";
}

/** Validation error with all missing/invalid fields collected */
export class ConfigValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super("Configuration validation failed:\n  - " + errors.join("\n  - "));
    this.name = "ConfigValidationError";
    this.errors = errors;
  }
}

let cachedConfig: AppConfig | null = null;

/**
 * Load and validate the configuration from environment variables.
 * Throws ConfigValidationError if required fields are missing.
 */
export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const errors: string[] = [];

  // --- Oracle connection ---
  const user = process.env.ORACLE_USER;
  const password = process.env.ORACLE_PASSWORD;
  const connectString = process.env.ORACLE_CONNECT_STRING;

  if (!user) errors.push("ORACLE_USER is required");
  if (!password) errors.push("ORACLE_PASSWORD is required");
  if (!connectString) errors.push("ORACLE_CONNECT_STRING is required");

  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }

  cachedConfig = {
    oracle: {
      user: user!,
      password: password!,
      connectString: connectString!,
      libDir: process.env.ORACLE_CLIENT_DIR || undefined,
      tnsAdmin: process.env.TNS_ADMIN || undefined,
      oracleHome: process.env.ORACLE_HOME || undefined,
    },

    pool: {
      min: parseInt(process.env.DB_POOL_MIN ?? "2", 10),
      max: parseInt(process.env.DB_POOL_MAX ?? "10", 10),
      increment: parseInt(process.env.DB_POOL_INCREMENT ?? "1", 10),
      timeoutSec: parseInt(process.env.DB_POOL_TIMEOUT ?? "30", 10),
      pingIntervalSec: parseInt(process.env.DB_POOL_PING_INTERVAL ?? "60", 10),
      connectionTimeoutMs: parseInt(
        process.env.DB_POOL_CONNECT_TIMEOUT_MS ?? "5000",
        10
      ),
    },

    limits: {
      maxRows: parseInt(process.env.QUERY_MAX_ROWS ?? "500", 10),
      queryTimeoutMs: parseInt(process.env.QUERY_TIMEOUT_MS ?? "10000", 10),
      maxSqlLength: parseInt(process.env.SQL_MAX_LENGTH ?? "5000", 10),
      maxWhereLength: parseInt(process.env.WHERE_MAX_LENGTH ?? "2000", 10),
      maxDmlRows: parseInt(process.env.DML_MAX_ROWS ?? "1000", 10),
    },

    rateLimit: {
      enabled: process.env.RATE_LIMIT_ENABLED !== "false",
      maxRequestsPerMinute: parseInt(
        process.env.RATE_LIMIT_PER_MINUTE ?? "60",
        10
      ),
    },

    access: {
      allowedTables: parseTableList(process.env.ALLOWED_TABLES),
      blockedTables: parseTableList(process.env.BLOCKED_TABLES),
      readOnly: process.env.READ_ONLY_MODE === "true",
    },

    log: {
      level: parseLogLevel(process.env.LOG_LEVEL),
      json: process.env.LOG_JSON === "true",
    },

    server: {
      name: "gy-oracle-database-mcp-server",
      version: "3.1.0",
    },
  };

  return cachedConfig;
}

/** Get the cached config (must be called after loadConfig) */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

/** Reset cached config (for testing) */
export function resetConfig(): void {
  cachedConfig = null;
}
