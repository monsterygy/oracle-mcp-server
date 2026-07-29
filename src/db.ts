/**
 * db.ts - Oracle database connection pool, query utilities, and safety layer
 *
 * Production-grade features:
 * - Connection pooling with exponential-backoff retry on transient errors
 * - Dead connection detection and pool recovery
 * - Read-only query enforcement (blocks DML/DDL in db_query)
 * - Automatic row limits via ROWNUM / FETCH FIRST n ROWS
 * - Bind variables — SQL injection prevention
 * - Oracle type conversion (DATE, TIMESTAMP, CLOB, BLOB → JS types)
 * - Table whitelist/blacklist access control
 * - DML safety: dry-run count + max rows cap before mutation
 * - Transaction support for multi-step atomic operations
 * - Execution plan preview
 * - Structured logging via the logger module
 */

import oracledb from "oracledb";
import fs from "fs";
import path from "path";
import { getConfig } from "./config.js";
import { getLogger } from "./logger.js";
import {
  ConnectionError,
  QueryError,
  TimeoutError,
  ValidationError,
  AccessDeniedError,
  TooManyRowsError,
  ReadOnlyModeError,
  isTransientError,
  toMcpError,
  type McpError,
} from "./errors.js";

// Re-export pure security functions (testable without DB)
export {
  IDENTIFIER_REGEX,
  isReadOnlyQuery,
  applyRowLimit,
  validateIdentifier,
} from "./security.js";
import {
  IDENTIFIER_REGEX,
  isReadOnlyQuery,
  applyRowLimit,
  validateIdentifier,
  parseTnsAliasesContent,
} from "./security.js";

// ================================================================
// Constants
// ================================================================

/** Oracle system schemas excluded from table listing */
const SYSTEM_SCHEMAS = [
  "SYS", "SYSTEM", "OUTLN", "DBSNMP", "APPQOSSYS", "DBSFWUSER",
  "REMOTE_SCHEDULER_AGENT", "GGSYS", "ANONYMOUS", "OJVMSYS",
  "XS$NULL", "GSMADMIN_INTERNAL", "DVF", "DVSYS", "LBACSYS",
  "AUDIT_SYS", "SYSBACKUP", "SYSDG", "SYSKM", "SYSRAC", "ORACLE_OCM",
  "SYS$UMF", "WMSYS", "ORDDATA", "ORDSYS", "CTXSYS", "MTSSYS", "EXFSYS",
  "MDSYS", "OLAPSYS", "XDB", "SI_INFORMTN_SCHEMA", "DMSYS", "TSMSYS",
  "WK_TEST", "WKPROXY", "WKSYS", "APEX_030200", "FLOWS_FILES", "APEX_PUBLIC_USER",
];

// ================================================================
// Oracle initialization
// ================================================================

// Set output format to object (key-value pairs instead of arrays)
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

// Fetch as string for dates to avoid timezone issues
// fetchAsString only accepts DATE, DB_TYPE_TIMESTAMP, DB_TYPE_NUMBER, DB_TYPE_RAW, DB_TYPE_CHAR
oracledb.fetchAsString = [
  oracledb.DATE,
  oracledb.DB_TYPE_TIMESTAMP,
];

const config = getConfig();
const logger = getLogger();

// Determine driver mode
// In oracledb 6.x, thin mode is the default (pure JS, no Oracle Client needed).
// If thick mode is requested, initOracledb must be called with libDir.
const isThickMode = !!config.oracle.libDir;
if (isThickMode) {
  try {
    (oracledb as any).initOracledb({ libDir: config.oracle.libDir });
    logger.info(`Oracle driver initialized in thick mode (libDir=${config.oracle.libDir})`);
  } catch (err) {
    logger.error("Failed to initialize Oracle thick mode, falling back to thin", err);
  }
}

// ================================================================
// Connection pool (singleton with retry)
// ================================================================

let pool: oracledb.Pool | null = null;
let poolInitPromise: Promise<oracledb.Pool> | null = null;
let poolResetCounter = 0;

/**
 * Get or create the singleton Oracle connection pool.
 * Uses exponential backoff retry for transient connection failures.
 */
export async function getPool(): Promise<oracledb.Pool> {
  if (pool) {
    // Verify pool is still healthy
    if ((oracledb as any).POOL_STATUS_UNKNOWN && pool.status === (oracledb as any).POOL_STATUS_UNKNOWN || pool.status === (oracledb as any).POOL_STATUS_DRAINING) {
      logger.warn("Pool is unhealthy or draining, reinitializing...");
      pool = null;
      poolInitPromise = null;
    } else {
      return pool;
    }
  }

  if (!poolInitPromise) {
    poolInitPromise = initPoolWithRetry();
  }

  try {
    const p = await poolInitPromise;
    pool = p;
    return p;
  } catch (error) {
    // Reset so next call retries
    poolInitPromise = null;
    throw error;
  }
}

/**
 * Initialize the connection pool with exponential backoff retry.
 * Retries up to 3 times for transient errors (network, auth during restart).
 */
async function initPoolWithRetry(): Promise<oracledb.Pool> {
  const maxRetries = 3;
  const baseDelayMs = 500;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const p = await createPool();
      logger.info(
        `Oracle connection pool created (attempt ${attempt}/${maxRetries})`
      );
      return p;
    } catch (error) {
      if (!isTransientError(error) && attempt < maxRetries) {
        // Non-transient error — don't retry
        throw toMcpError(error);
      }

      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(
          `Pool init attempt ${attempt} failed, retrying in ${delay}ms...`,
          { meta: { attempt } }
        );
        await sleep(delay);
      } else {
        // Last attempt failed
        throw new ConnectionError(
          `Failed to create Oracle connection pool after ${maxRetries} attempts`,
          { cause: error }
        );
      }
    }
  }

  // Should not reach here, but TypeScript needs it
  throw new ConnectionError("Unexpected: pool init exhausted retries");
}

async function createPool(): Promise<oracledb.Pool> {
  const cfg = getConfig();
  return oracledb.createPool({
    user: cfg.oracle.user,
    password: cfg.oracle.password,
    connectString: cfg.oracle.connectString,
    poolMin: cfg.pool.min,
    poolMax: cfg.pool.max,
    poolIncrement: cfg.pool.increment,
    poolTimeout: cfg.pool.timeoutSec,
    poolPingInterval: cfg.pool.pingIntervalSec,
    // Connection timeout (ms) for getConnection()
    _poolWaitTimeout: cfg.pool.connectionTimeoutMs,
  } as any);
}

/**
 * Get a connection from the pool with retry on transient errors.
 * If a connection is stale, the pool's pingInterval should catch it,
 * but we add an explicit retry for extra resilience.
 */
async function getConnection(): Promise<oracledb.Connection> {
  const p = await getPool();
  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const conn = await p.getConnection();
      return conn;
    } catch (error) {
      if (isTransientError(error) && attempt < maxRetries) {
        logger.warn(
          `getConnection attempt ${attempt} failed (transient): ${error instanceof Error ? error.message : String(error)}`
        );
        await sleep(300);
        continue;
      }
      throw new ConnectionError(
        `Failed to get database connection: ${error instanceof Error ? error.message : String(error)}`,
        { retriable: isTransientError(error), cause: error }
      );
    }
  }

  throw new ConnectionError("getConnection exhausted retries");
}

// ================================================================
// Oracle type conversion
// ================================================================

/**
 * Convert Oracle-specific types to plain JS values for MCP serialization.
 * - CLOB → string
 * - BLOB → hex string (or base64 if preferred)
 * - Numbers stay as numbers
 * - Strings stay as strings
 * - Dates already converted to string via fetchAsString
 */
function convertOracleValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  // oracledb.Lob (CLOB/BLOB)
  if (value && typeof value === "object" && "getData" in value && typeof (value as any).getData === "function") {
    // This is a Lob — we can't synchronously convert it here.
    // If fetchAsString didn't cover it, return a placeholder.
    // Full Lob reading requires async handling at the query level.
    return "[LOB]";
  }

  // BigInt (if any) → number
  if (typeof value === "bigint") {
    return Number(value);
  }

  // Buffer → base64 string
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  // Date object (shouldn't appear since fetchAsString handles dates, but just in case)
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

/**
 * Post-process all rows: convert any Oracle-specific types to JSON-serializable values.
 */
function convertRows(rows: any[]): Record<string, unknown>[] {
  if (!rows || rows.length === 0) return [];

  return rows.map((row) => {
    if (typeof row !== "object" || row === null) return row;
    const converted: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      converted[key] = convertOracleValue(row[key]);
    }
    return converted;
  });
}

/**
 * Read all CLOB/BLOB values asynchronously after query execution.
 * Must be called before convertRows for any columns that are LOBs.
 */
async function readLobs(result: oracledb.Result<unknown>): Promise<void> {
  if (!result.rows || result.rows.length === 0) return;
  if (!result.metaData || result.metaData.length === 0) return;

  // Find LOB columns
  const lobColIndices: number[] = [];
  for (let i = 0; i < result.metaData.length; i++) {
    const dbType = (result.metaData[i] as any).dbType;
    // dbType constants: 6 = CLOB, 7 = BLOB (in @types/oracledb, these are CLOB/BLOB)
    if (dbType === oracledb.DB_TYPE_CLOB || dbType === oracledb.DB_TYPE_NCLOB || dbType === oracledb.DB_TYPE_BLOB) {
      lobColIndices.push(i);
    }
  }

  if (lobColIndices.length === 0) return;

  // Read each LOB value
  for (const row of result.rows as any[]) {
    if (Array.isArray(row)) {
      for (const idx of lobColIndices) {
        const lob = row[idx];
        if (lob && typeof lob.getData === "function") {
          const colName = result.metaData[idx].name;
          if (oracledb.DB_TYPE_BLOB === (result.metaData[idx] as any).dbType) {
            const data = await lob.getData();
            row[idx] = Buffer.isBuffer(data) ? data.toString("base64") : String(data);
          } else {
            row[idx] = await lob.getData();
          }
        }
      }
    } else {
      // Object format — read by column name
      for (const idx of lobColIndices) {
        const colName = result.metaData[idx].name;
        const lob = row[colName];
        if (lob && typeof lob.getData === "function") {
          if (oracledb.DB_TYPE_BLOB === (result.metaData[idx] as any).dbType) {
            const data = await lob.getData();
            row[colName] = Buffer.isBuffer(data) ? data.toString("base64") : String(data);
          } else {
            row[colName] = await lob.getData();
          }
        }
      }
    }
  }
}

// ================================================================
// Table access control
// ================================================================

/**
 * Check if a table is accessible per the configured whitelist/blacklist.
 * Throws AccessDeniedError if blocked.
 */
export function checkTableAccess(tableName: string): void {
  const cfg = getConfig();
  const upper = tableName.toUpperCase();

  // Blocklist takes priority
  if (cfg.access.blockedTables.includes(upper)) {
    throw new AccessDeniedError(upper, "table is in the BLOCKED_TABLES list");
  }

  // If whitelist is non-empty, table must be in it
  if (cfg.access.allowedTables.length > 0 && !cfg.access.allowedTables.includes(upper)) {
    throw new AccessDeniedError(
      upper,
      "table is not in the ALLOWED_TABLES whitelist"
    );
  }
}

/** Check if DML operations are allowed (not in read-only mode) */
export function checkDmlAllowed(): void {
  const cfg = getConfig();
  if (cfg.access.readOnly) {
    throw new ReadOnlyModeError();
  }
}

// ================================================================
// Query execution timeout
// ================================================================

/**
 * Execute a query with a timeout guard (Promise.race).
 * Uses AbortController if available, otherwise falls back to Promise.race.
 */
async function executeWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(timeoutMs)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ================================================================
// Query execution functions
// ================================================================

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  /** Column metadata */
  columns?: { name: string; dataType?: string }[];
}

/**
 * Execute a read-only SELECT query with safety guardrails.
 *
 * - Validates that only SELECT/WITH queries are run
 * - Enforces row limit if not present
 * - Query timeout via Promise.race
 * - Returns truncated flag if results exceed maxRows
 * - Converts Oracle types to JSON-serializable values
 */
export async function executeReadOnlyQuery(
  sql: string,
  params: unknown[] = [],
  options: { maxRows?: number } = {}
): Promise<QueryResult> {
  const cfg = getConfig();
  const maxRows = options.maxRows ?? cfg.limits.maxRows;

  if (!isReadOnlyQuery(sql)) {
    throw new ValidationError(
      "Only SELECT or WITH (CTE) queries are allowed. INSERT/UPDATE/DELETE/DROP and other modifying statements are blocked.",
      { code: "READ_ONLY_VIOLATION" }
    );
  }

  if (sql.length > cfg.limits.maxSqlLength) {
    throw new ValidationError(
      `SQL query too long (${sql.length} chars, max ${cfg.limits.maxSqlLength}).`
    );
  }

  const connection = await getConnection();

  try {
    const finalSql = applyRowLimit(sql, maxRows);
    logger.debug(`Executing read-only query (${sql.length} chars, max ${maxRows} rows)`);

    const execPromise = connection.execute(finalSql, params as oracledb.BindParameters);
    const result = await executeWithTimeout(execPromise, cfg.limits.queryTimeoutMs);

    // Read any LOB values asynchronously
    await readLobs(result);

    const rows = convertRows((result.rows ?? []) as any[]);
    const truncated = rows.length > maxRows;
    const finalRows = truncated ? rows.slice(0, maxRows) : rows;

    // Extract column metadata
    const columns = result.metaData
      ? result.metaData.map((m: any) => ({ name: m.name, dataType: m.dbType ? String(m.dbType) : undefined }))
      : undefined;

    return { rows: finalRows, rowCount: finalRows.length, truncated, columns };
  } finally {
    await connection.close();
  }
}

export interface WriteResult {
  rowsAffected: number;
}

/**
 * Execute a parameterized write query (INSERT/UPDATE/DELETE).
 * - autoCommit enabled
 * - Timeout enforced
 * - If dry_run, the SQL is returned without execution
 */
export async function executeWriteQuery(
  sql: string,
  params: oracledb.BindParameters = [],
  options: { dryRun?: boolean } = {}
): Promise<WriteResult & { dryRun?: boolean; sql: string }> {
  checkDmlAllowed();
  const cfg = getConfig();

  if (options.dryRun) {
    return { rowsAffected: 0, dryRun: true, sql };
  }

  const connection = await getConnection();

  try {
    logger.debug(`Executing write query (${sql.length} chars)`);

    const execPromise = connection.execute(sql, params, {
      autoCommit: true,
    });
    const result = await executeWithTimeout(execPromise, cfg.limits.queryTimeoutMs);

    return { rowsAffected: result.rowsAffected ?? 0, sql };
  } finally {
    await connection.close();
  }
}

/**
 * Execute an INSERT and return the inserted row via ROWID.
 */
export async function executeInsertAndReturn(
  sql: string,
  binds: oracledb.BindParameters,
  tableName: string
): Promise<{ row: Record<string, unknown> | null; rowsAffected: number }> {
  checkDmlAllowed();
  const cfg = getConfig();
  const connection = await getConnection();

  try {
    logger.debug(`Executing INSERT with return (${sql.length} chars)`);

    const execPromise = connection.execute(sql, binds);
    const result = await executeWithTimeout(execPromise, cfg.limits.queryTimeoutMs);

    const rowsAffected = result.rowsAffected ?? 0;

    // Get the ROWID of the inserted row
    const rowid = (result as any).lastRowid;

    let insertedRow: Record<string, unknown> | null = null;
    if (rowid) {
      const selectSql = `SELECT * FROM ${tableName} WHERE ROWID = :rowid_val`;
      const rowResult = await connection.execute(selectSql, {
        rowid_val: rowid,
      });
      await readLobs(rowResult);
      const rows = convertRows((rowResult.rows ?? []) as any[]);
      insertedRow = rows.length > 0 ? rows[0] : null;
    }

    await connection.commit();
    return { row: insertedRow, rowsAffected };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw toMcpError(error);
  } finally {
    await connection.close();
  }
}

/**
 * Pre-count how many rows a DML statement would affect.
 * Used for the safety check before UPDATE/DELETE.
 */
export async function countMatchingRows(
  tableName: string,
  whereClause: string,
  whereParams: oracledb.BindParameters
): Promise<number> {
  const connection = await getConnection();

  try {
    const countSql = `SELECT COUNT(*) AS cnt FROM ${tableName} WHERE ${whereClause}`;
    const result = await executeWithTimeout(
      connection.execute(countSql, whereParams),
      getConfig().limits.queryTimeoutMs
    );

    const rows = (result.rows ?? []) as any[];
    return rows.length > 0 ? Number(rows[0].cnt ?? rows[0].CNT ?? 0) : 0;
  } finally {
    await connection.close();
  }
}

/**
 * Check DML safety: count matching rows and throw if exceeding the limit.
 */
export async function checkDmlSafety(
  tableName: string,
  whereClause: string,
  whereParams: oracledb.BindParameters
): Promise<number> {
  const cfg = getConfig();
  const count = await countMatchingRows(tableName, whereClause, whereParams);

  if (count > cfg.limits.maxDmlRows) {
    throw new TooManyRowsError(count, cfg.limits.maxDmlRows);
  }

  return count;
}

// ================================================================
// Transaction support
// ================================================================

export interface TransactionStep {
  sql: string;
  params?: unknown[];
}

export interface TransactionResult {
  committed: boolean;
  results: { rowsAffected: number; sql: string }[];
}

/**
 * Execute multiple DML statements in a single transaction.
 * All succeed or all roll back.
 */
export async function executeInTransaction(
  steps: TransactionStep[]
): Promise<TransactionResult> {
  checkDmlAllowed();
  const cfg = getConfig();

  if (steps.length === 0) {
    throw new ValidationError("Transaction requires at least one step.");
  }

  if (steps.length > 10) {
    throw new ValidationError(
      `Transaction has too many steps (${steps.length}, max 10). Break into smaller transactions.`
    );
  }

  const connection = await getConnection();
  const results: { rowsAffected: number; sql: string }[] = [];

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      logger.debug(`Transaction step ${i + 1}/${steps.length}: ${step.sql.slice(0, 80)}...`);

      const execPromise = connection.execute(step.sql, step.params as oracledb.BindParameters);
      const result = await executeWithTimeout(execPromise, cfg.limits.queryTimeoutMs);
      results.push({
        rowsAffected: result.rowsAffected ?? 0,
        sql: step.sql,
      });
    }

    await connection.commit();
    logger.info(`Transaction committed: ${steps.length} steps, ${results.reduce((s, r) => s + r.rowsAffected, 0)} rows affected`);
    return { committed: true, results };
  } catch (error) {
    await connection.rollback().catch(() => {});
    logger.warn(`Transaction rolled back: ${error instanceof Error ? error.message : String(error)}`);
    throw toMcpError(error);
  } finally {
    await connection.close();
  }
}

// ================================================================
// Execution plan
// ================================================================

/**
 * Get the execution plan for a SQL statement using EXPLAIN PLAN.
 * Does not execute the query — only estimates the plan.
 */
export async function getExplainPlan(sql: string, params: unknown[] = []): Promise<string[]> {
  if (!isReadOnlyQuery(sql)) {
    throw new ValidationError("Explain plan is only available for SELECT/WITH queries.");
  }

  const connection = await getConnection();
  const stmtId = Math.floor(Math.random() * 1000000);

  try {
    // Step 1: Generate the plan
    const planSql = `EXPLAIN PLAN SET STATEMENT_ID = 'MCP_${stmtId}' FOR ${applyRowLimit(sql, 1)}`;
    await connection.execute(planSql, params as oracledb.BindParameters);

    // Step 2: Read the plan from plan_table
    const readSql = `SELECT LPAD(' ', 2 * LEVEL - 1) || operation || ' ' ||
                           NVL(options, '') || ' ' ||
                           NVL(object_name, '') AS plan_line
                      FROM plan_table
                     WHERE statement_id = 'MCP_${stmtId}'
                  CONNECT BY PRIOR id = parent_id
                        AND statement_id = 'MCP_${stmtId}'
                  START WITH id = 0
                        AND statement_id = 'MCP_${stmtId}'`;

    const result = await connection.execute(readSql);
    const rows = (result.rows ?? []) as any[];

    // Clean up the plan table entries
    await connection.execute(
      `DELETE FROM plan_table WHERE statement_id = 'MCP_${stmtId}'`
    );
    await connection.commit();

    return rows.map((r) => r.plan_line ?? r.PLAN_LINE ?? "").filter((s: string) => s.length > 0);
  } finally {
    await connection.close();
  }
}

// ================================================================
// Session info
// ================================================================

export interface SessionInfo {
  userName: string;
  schema: string;
  instanceName: string;
  hostName: string;
  dbName: string;
  dbVersion: string;
  serverVersion: string;
  sid: number;
  serialNum: number;
  server: string;
  currentTime: string;
  nlsDateFormat: string;
  nlsTimestampFormat: string;
}

/**
 * Get current session information for the database connection.
 */
export async function getSessionInfo(): Promise<SessionInfo> {
  const connection = await getConnection();

  try {
    const result = await connection.execute(
      `SELECT
         sys_context('USERENV', 'SESSION_USER')     AS "userName",
         sys_context('USERENV', 'CURRENT_SCHEMA')    AS "schema",
         sys_context('USERENV', 'INSTANCE_NAME')     AS "instanceName",
         sys_context('USERENV', 'SERVER_HOST')       AS "hostName",
         sys_context('USERENV', 'DB_NAME')           AS "dbName",
         banner                                       AS "dbVersion",
         sys_context('USERENV', 'SID')                AS "sid",
         sys_context('USERENV', 'SERVER')             AS "server",
         to_char(sysdate, 'YYYY-MM-DD HH24:MI:SS')    AS "currentTime",
         nls_date_format                              AS "nlsDateFormat"
       FROM v$version
       WHERE ROWNUM = 1`
    );

    // Also get NLS timestamp format and session serial number
    const result2 = await connection.execute(
      `SELECT
         value AS "nlsTimestampFormat"
       FROM nls_session_parameters
       WHERE parameter = 'NLS_TIMESTAMP_FORMAT'`
    );

    const result3 = await connection.execute(
      `SELECT sid AS "sid", serial# AS "serialNum"
       FROM v$session
       WHERE audsid = sys_context('USERENV', 'SESSIONID')
       AND ROWNUM = 1`
    );

    const row = (result.rows ?? [{}])[0] as any;
    const row2 = (result2.rows ?? [{}])[0] as any;
    const row3 = (result3.rows ?? [{}])[0] as any;

    return {
      userName: row.userName ?? "unknown",
      schema: row.schema ?? "unknown",
      instanceName: row.instanceName ?? "unknown",
      hostName: row.hostName ?? "unknown",
      dbName: row.dbName ?? "unknown",
      dbVersion: row.dbVersion ?? "unknown",
      serverVersion: row.dbVersion ?? "unknown",
      sid: Number(row.sid ?? 0),
      serialNum: Number(row3?.serialNum ?? 0),
      server: row.server ?? "unknown",
      currentTime: row.currentTime ?? "unknown",
      nlsDateFormat: row.nlsDateFormat ?? "unknown",
      nlsTimestampFormat: row2?.nlsTimestampFormat ?? "unknown",
    };
  } finally {
    await connection.close();
  }
}

// ================================================================
// Schema exploration
// ================================================================

/**
 * List all user tables in the Oracle database (excludes system schemas).
 * Optionally filter by owner/schema.
 */
export async function listTables(ownerFilter?: string): Promise<
  { owner: string; table: string }[]
> {
  const connection = await getConnection();

  try {
    let query = `SELECT owner AS "owner", table_name AS "table"
                 FROM all_tables
                 WHERE owner NOT IN (${SYSTEM_SCHEMAS.map((_, i) => `:${i + 1}`).join(", ")})
              `;
    const binds: string[] = [...SYSTEM_SCHEMAS];

    if (ownerFilter) {
      const idx = binds.length + 1;
      query += ` AND owner = UPPER(:${idx})`;
      binds.push(ownerFilter);
    }

    query += ` ORDER BY owner, table_name`;

    const result = await connection.execute(query, binds);
    return (result.rows ?? []) as { owner: string; table: string }[];
  } finally {
    await connection.close();
  }
}

/**
 * Describe a table's column structure (Oracle all_tab_columns).
 * Optionally specify owner for cross-schema access.
 */
export async function describeTable(
  tableName: string,
  owner?: string
): Promise<
  {
    column: string;
    dataType: string;
    dataLength: number | null;
    nullable: string;
    defaultValue: string | null;
  }[]
> {
  const connection = await getConnection();

  try {
    let query = `SELECT column_name    AS "column",
                        data_type      AS "dataType",
                        data_length    AS "dataLength",
                        nullable       AS "nullable",
                        data_default   AS "defaultValue"
                 FROM all_tab_columns
                 WHERE table_name = UPPER(:1)`;
    const binds: unknown[] = [tableName.toUpperCase()];

    if (owner) {
      query += ` AND owner = UPPER(:2)`;
      binds.push(owner.toUpperCase());
    }

    query += ` ORDER BY column_id`;

    const result = await connection.execute(query, binds);
    return (result.rows ?? []) as any[];
  } finally {
    await connection.close();
  }
}

// ================================================================
// Pool management
// ================================================================

/** Gracefully close the connection pool */
export async function closePool(): Promise<void> {
  if (pool) {
    logger.info("Closing Oracle connection pool...");
    try {
      await pool.close(0);
    } catch (err) {
      logger.error("Error closing pool", err);
    }
    pool = null;
    poolInitPromise = null;
    poolResetCounter++;
  }
}

// ================================================================
// TNS support: find and parse tnsnames.ora
// ================================================================

/**
 * Locate the tnsnames.ora file.
 * Search order:
 * 1. TNS_ADMIN environment variable
 * 2. ORACLE_HOME/network/admin/
 * 3. Current working directory (fallback)
 */
export function findTnsNamesPath(): string | null {
  const cfg = getConfig();

  // 1. TNS_ADMIN env var (highest priority)
  if (cfg.oracle.tnsAdmin) {
    const p = path.join(cfg.oracle.tnsAdmin, "tnsnames.ora");
    if (fs.existsSync(p)) return p;
  }

  // 2. ORACLE_HOME/network/admin
  if (cfg.oracle.oracleHome) {
    const p = path.join(cfg.oracle.oracleHome, "network", "admin", "tnsnames.ora");
    if (fs.existsSync(p)) return p;
  }

  // 3. Current working directory as a last resort
  const cwdPath = path.join(process.cwd(), "tnsnames.ora");
  if (fs.existsSync(cwdPath)) return cwdPath;

  return null;
}

/**
 * Parse tnsnames.ora and extract all TNS alias names.
 * Delegates the parsing logic to the pure function in security.ts.
 */
export function parseTnsAliases(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf-8");
  return parseTnsAliasesContent(content);
}

// ================================================================
// Health check
// ================================================================

export interface HealthCheckResult {
  driverVersion: string;
  driverMode: string;
  dbVersion: string;
  connected: boolean;
  connectString: string;
  tnsAdmin: string | null;
  tnsNamesPath: string | null;
  tnsAliases: string[];
  poolStats: { open: number; inUse: number; available: number } | null;
  error?: string;
}

/**
 * Health check: test the Oracle connection and return diagnostics.
 */
export async function healthCheck(): Promise<HealthCheckResult> {
  const cfg = getConfig();
  const tnsPath = findTnsNamesPath();
  const tnsAliases = tnsPath ? parseTnsAliases(tnsPath) : [];

  const driverMode = isThickMode
    ? "thick (requires Oracle Client)"
    : "thin (pure JS, no Oracle Client needed)";

  const connectString = cfg.oracle.connectString;

  // Pool stats
  let poolStats: HealthCheckResult["poolStats"] = null;
  if (pool) {
    try {
      poolStats = {
        open: pool.connectionsOpen,
        inUse: pool.connectionsInUse,
        available: pool.connectionsOpen - pool.connectionsInUse,
      };
    } catch {
      poolStats = null;
    }
  }

  // Try to connect and run a simple query
  try {
    const p = await getPool();
    const connection = await p.getConnection();

    try {
      const result = await connection.execute(
        `SELECT banner AS "banner" FROM v$version WHERE banner LIKE 'Oracle%'`
      );
      const rows = (result.rows ?? []) as { banner: string }[];
      const dbVersion = rows.length > 0 ? rows[0].banner : "unknown";

      return {
        driverVersion: String(oracledb.version ?? "unknown"),
        driverMode,
        dbVersion,
        connected: true,
        connectString,
        tnsAdmin: cfg.oracle.tnsAdmin ?? null,
        tnsNamesPath: tnsPath,
        tnsAliases,
        poolStats,
      };
    } finally {
      await connection.close();
    }
  } catch (error) {
    return {
      driverVersion: String(oracledb.version ?? "unknown"),
      driverMode,
      dbVersion: "connection failed",
      connected: false,
      connectString,
      tnsAdmin: cfg.oracle.tnsAdmin ?? null,
      tnsNamesPath: tnsPath,
      tnsAliases,
      poolStats,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ================================================================
// Utilities
// ================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export oracledb for use in index.ts
export { oracledb };
