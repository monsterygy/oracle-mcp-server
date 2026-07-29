/**
 * security.ts - Pure security functions with no side effects
 *
 * Extracted from db.ts so they can be unit-tested without a database connection.
 * These functions form the security boundary of the MCP server.
 */

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
