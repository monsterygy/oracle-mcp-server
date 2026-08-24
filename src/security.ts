/**
 * security.ts - Pure security functions with no side effects
 *
 * Extracted from db.ts so they can be unit-tested without a database connection.
 * These functions form the security boundary of the MCP server.
 */

import { ValidationError } from "./errors.js";

/** Regex to validate Oracle identifiers (table/column names) */
export const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;

/** Known inner keywords of tnsnames.ora to filter out when extracting aliases */
export const TNS_INNER_KEYWORDS = new Set([
  "DESCRIPTION", "DESCRIPTION_LIST", "ADDRESS", "ADDRESS_LIST",
  "CONNECT_DATA", "FAILOVER", "LOAD_BALANCE", "SOURCE_ROUTE",
  "PROTOCOL", "HOST", "PORT", "SERVICE_NAME", "SID",
  "SERVER", "INSTANCE_NAME", "SHUTDOWN", "UR",
  "SECURITY", "SSL_SERVER_CERT_DN", "AUTHENTICATION_SERVICES",
]);

/**
 * Check if a SQL statement is read-only.
 * Only SELECT and WITH (Common Table Expressions) are allowed.
 * Also blocks multi-statement injection (semicolons followed by more SQL).
 */
export function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim();

  // Block multiple statements (semicolon followed by more content)
  // Allow a single trailing semicolon only
  const semiIndex = trimmed.indexOf(";");
  if (semiIndex !== -1) {
    const afterSemi = trimmed.slice(semiIndex + 1).trim();
    if (afterSemi.length > 0) return false;
  }

  const upper = trimmed.toUpperCase();

  // Must start with SELECT or WITH
  if (!/^(SELECT|WITH)\b/.test(upper)) {
    return false;
  }

  // Block data-modification keywords anywhere in the query
  // Using word boundaries to avoid false positives like "updated_at"
  const forbidden =
    /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|MERGE|CALL|EXEC|EXECUTE)\b/;
  return !forbidden.test(upper);
}

/**
 * Wrap a SELECT query with a row limit if it doesn't already have one.
 * Uses FETCH FIRST n ROWS ONLY (Oracle 12c+).
 */
export function applyRowLimit(sql: string, maxRows: number): string {
  const upper = sql.toUpperCase();
  const hasRowLimit =
    /\bROWNUM\b\s*<=\s*\d/i.test(sql) ||
    /\bFETCH\s+FIRST\b/i.test(upper) ||
    /\bFETCH\s+NEXT\b/i.test(upper);

  // Strip trailing semicolon
  const cleanSql = sql.replace(/;\s*$/, "");

  if (hasRowLimit) return cleanSql;

  return `${cleanSql} FETCH FIRST ${maxRows + 1} ROWS ONLY`;
}

/**
 * Parse tnsnames.ora content and extract all TNS alias names.
 * Pure function — accepts file content as string, no file I/O.
 */
export function parseTnsAliasesContent(content: string): string[] {
  // Remove comment lines (starting with #)
  const cleaned = content
    .split("\n")
    .map((l) => l.replace(/#.*$/, ""))
    .join("\n");

  // Match: start of line, identifier, optional whitespace, =
  const matches = [...cleaned.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)];

  const aliases: string[] = [];
  for (const m of matches) {
    const name = m[1].toUpperCase();
    if (!TNS_INNER_KEYWORDS.has(name) && !aliases.includes(m[1])) {
      aliases.push(m[1]);
    }
  }

  return aliases;
}

/**
 * Validate an Oracle identifier (table/column name).
 * Throws if invalid.
 */
export function validateIdentifier(name: string): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(
      `Invalid identifier '${name}'. Only alphanumeric and underscore characters are allowed; ` +
      `must start with a letter or underscore, max 128 characters.`
    );
  }
}

/**
 * Check if a table name is allowed per whitelist/blacklist configuration.
 * Pure function — takes the lists as parameters.
 */
export function isTableAllowed(
  tableName: string,
  allowedTables: string[],
  blockedTables: string[]
): { allowed: boolean; reason?: string } {
  const upper = tableName.toUpperCase();
  // Normalize both lists to uppercase for case-insensitive comparison
  const upperBlocked = blockedTables.map((t) => t.toUpperCase());
  const upperAllowed = allowedTables.map((t) => t.toUpperCase());

  if (upperBlocked.includes(upper)) {
    return { allowed: false, reason: "table is in the BLOCKED_TABLES list" };
  }

  if (upperAllowed.length > 0 && !upperAllowed.includes(upper)) {
    return { allowed: false, reason: "table is not in the ALLOWED_TABLES whitelist" };
  }

  return { allowed: true };
}

// ================================================================
// Bind value precision guard (big numbers > 2^53)
// ================================================================

/**
 * JavaScript numbers are IEEE-754 doubles: any integer whose absolute value
 * exceeds 2^53 - 1 (Number.MAX_SAFE_INTEGER) is silently rounded to the
 * nearest representable double. Oracle NUMBER, by contrast, stores up to 38
 * decimal digits exactly. Binding such a JS number to an Oracle NUMBER
 * column therefore corrupts the value before it ever reaches the database
 * (e.g. 9007199254740993 becomes 9007199254740992).
 *
 * The guard rejects unsafe numeric binds so the caller must pass the value
 * as a string (e.g. "9007199254740993"), which Oracle converts to NUMBER
 * with full precision via implicit conversion.
 */
export const BIND_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/** Keys that identify an oracledb bind definition object ({ val, type, dir, ... }) */
const BIND_DEFINITION_KEYS = new Set(["val", "type", "dir", "maxSize", "maxArraySize"]);

export type UnsafeBindReason = "unsafe-integer" | "non-finite";

export interface UnsafeBindInfo {
  value: number;
  reason: UnsafeBindReason;
}

function inspectBindValue(value: unknown): UnsafeBindInfo | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { value, reason: "non-finite" };
    }
    if (Number.isInteger(value) && Math.abs(value) > BIND_MAX_SAFE_INTEGER) {
      return { value, reason: "unsafe-integer" };
    }
    return null;
  }
  // oracledb bind definition: { val, type?, dir?, ... } — inspect the inner val
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if ("val" in obj && Object.keys(obj).every((k) => BIND_DEFINITION_KEYS.has(k))) {
      return inspectBindValue(obj.val);
    }
  }
  return null;
}

/**
 * Validate bind values for precision safety.
 * Throws ValidationError (code BIND_PRECISION_ERROR) listing every unsafe
 * numeric bind instead of silently corrupting data.
 *
 * @param params  Array of positional binds (:1, :2, ...) or record of named binds
 * @param context Label used in the error message (e.g. "db_insert data")
 */
export function assertSafeBindValues(params: unknown, context = "bind parameters"): void {
  if (params === null || params === undefined) return;

  const offenders: { location: string; info: UnsafeBindInfo }[] = [];

  if (Array.isArray(params)) {
    for (let i = 0; i < params.length; i++) {
      const info = inspectBindValue(params[i]);
      if (info) offenders.push({ location: "[" + i + "]", info });
    }
  } else if (typeof params === "object") {
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      const info = inspectBindValue(value);
      if (info) offenders.push({ location: '"' + key + '"', info });
    }
  }

  if (offenders.length > 0) {
    const details = offenders
      .map((o) => {
        const shown = String(o.info.value);
        const reason =
          o.info.reason === "unsafe-integer"
            ? "|value| exceeds 2^53 - 1, silent precision loss"
            : "not a finite number, invalid for Oracle NUMBER";
        return o.location + ": " + shown + " (" + reason + ")";
      })
      .join("; ");
    throw new ValidationError(
      "Unsafe numeric bind value(s) detected in " + context + " — " + details + ". " +
      "JavaScript numbers lose precision beyond 2^53 - 1 (" + BIND_MAX_SAFE_INTEGER + "); " +
      "Oracle NUMBER keeps 38 digits exact. Pass the value as a string instead " +
      '(e.g. "9007199254740993") and Oracle will convert it with full precision.',
      {
        code: "BIND_PRECISION_ERROR",
        hint:
          'Pass big integers as strings, e.g. where_params: ["9007199254740993"] ' +
          "instead of [9007199254740993].",
      }
    );
  }
}

// ================================================================
// ROWID-based row fetch
// ================================================================

/**
 * Build the SQL used to fetch a row back by its ROWID.
 *
 * ROWID is a physical row locator returned by oracledb as `lastRowid` after
 * an INSERT — it is the only stable handle to the exact row just inserted.
 * Fetching by ROWID avoids re-selecting by big-number keys, which are subject
 * to the 2^53 precision loss described above.
 */
export function buildRowidSelectSql(tableName: string): string {
  validateIdentifier(tableName);
  return "SELECT * FROM " + tableName.toUpperCase() + " WHERE ROWID = :rowid_val";
}

