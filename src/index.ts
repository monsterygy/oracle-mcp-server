#!/usr/bin/env node
/**
 * Oracle Database MCP Server — Production Edition
 *
 * 11 tools for full Oracle database interaction:
 *   1.  db_health_check   — Verify driver & connection diagnostics
 *   2.  db_list_tns        — Parse tnsnames.ora aliases
 *   3.  db_list_tables     — List all tables (optional schema filter)
 *   4.  db_describe_table  — Get column schema of a table
 *   5.  db_query           — Execute read-only SQL (SELECT/WITH only)
 *   6.  db_explain_plan    — Preview execution plan without running
 *   7.  db_insert          — Insert a record (with dry_run support)
 *   8.  db_update          — Update records matching WHERE (with dry_run + safety cap)
 *   9.  db_delete          — Delete records matching WHERE (with dry_run + safety cap)
 *  10.  db_transaction     — Multi-step atomic transaction
 *  11.  db_session_info    — Current session/privilege info
 *
 * Production features:
 *   - Centralized config validation (config.ts)
 *   - Structured logging with request IDs (logger.ts)
 *   - Custom error types with codes (errors.ts)
 *   - Rate limiting (rateLimiter.ts)
 *   - Connection retry with exponential backoff
 *   - Table whitelist/blacklist enforcement
 *   - Read-only mode support
 *   - DML safety cap (max rows affected)
 *   - Dry-run mode for all DML tools
 *   - Oracle type conversion (DATE/CLOB/BLOB → JS types)
 *
 * Transport: stdio (for local integration with MCP clients)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Load and validate config FIRST — fails fast on missing env vars
import { loadConfig, getConfig } from "./config.js";
loadConfig();

import { getLogger, generateRequestId, type RequestContext } from "./logger.js";
import { getRateLimiter } from "./rateLimiter.js";
import { toMcpError } from "./errors.js";
import {
  getPool,
  executeReadOnlyQuery,
  executeWriteQuery,
  executeInsertAndReturn,
  executeInTransaction,
  getExplainPlan,
  getSessionInfo,
  checkDmlSafety,
  countMatchingRows,
  listTables,
  describeTable,
  closePool,
  healthCheck,
  findTnsNamesPath,
  parseTnsAliases,
  validateIdentifier,
  checkTableAccess,
  checkDmlAllowed,
  isReadOnlyQuery,
  oracledb,
  type TransactionStep,
} from "./db.js";

const config = getConfig();
const logger = getLogger();

const server = new McpServer({
  name: config.server.name,
  version: config.server.version,
});

const rateLimiter = getRateLimiter();

// ================================================================
// Helper: wrap tool handler with rate limit + error handling
// ================================================================

function wrapHandler<T extends (args: any, context?: RequestContext) => Promise<any>>(
  toolName: string,
  handler: T
): any {
  return (async (args: any) => {
    const ctx: RequestContext = {
      requestId: generateRequestId(),
      tool: toolName,
    };

    // Rate limit check
    try {
      rateLimiter.check();
    } catch (rateError) {
      logger.warn(`Rate limited: ${toolName}`, ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: rateError instanceof Error
              ? rateError.message
              : "Rate limit exceeded",
          },
        ],
        isError: true,
      };
    }

    const startTime = Date.now();

    try {
      logger.info(`Tool invoked: ${toolName}`, ctx);
      const result = await handler(args, ctx);
      const duration = Date.now() - startTime;
      logger.info(`Tool completed: ${toolName} (${duration}ms)`, ctx);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const mcpError = toMcpError(error);
      logger.error(
        `Tool failed: ${toolName} (${duration}ms)`,
        error,
        ctx
      );
      return {
        content: [
          {
            type: "text" as const,
            text: mcpError.toText(),
          },
        ],
        isError: true,
      };
    }
  }) as T;
}

// ================================================================
// Tool 1: db_health_check
// ================================================================
server.registerTool(
  "db_health_check",
  {
    title: "Health check: verify driver & connection",
    description: `Verify that the Oracle driver is loaded correctly and the database connection is working.

Reports: oracledb driver version, driver mode (thin/thick), connection status, Oracle DB version, connect string, TNS config, pool stats, and available TNS aliases.

**Use this tool FIRST** when setting up the MCP server or when troubleshooting connection issues.

No parameters required.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  wrapHandler("db_health_check", async () => {
    const info = await healthCheck();

    const lines = [
      "# Oracle MCP Health Check",
      "",
      "| Check | Status |",
      "|-------|--------|",
      `| oracledb version | ${info.driverVersion} |`,
      `| Driver mode | ${info.driverMode} |`,
      `| Connection | ${info.connected ? "✅ Connected" : "❌ Failed"} |`,
      `| Oracle DB version | ${info.dbVersion} |`,
      `| Connect string | \`${info.connectString}\` |`,
      `| TNS_ADMIN | ${info.tnsAdmin ?? "(not set)"} |`,
      `| tnsnames.ora | ${info.tnsNamesPath ?? "(not found)"} |`,
    ];

    if (info.poolStats) {
      lines.push(
        `| Pool: open | ${info.poolStats.open} |`,
        `| Pool: in-use | ${info.poolStats.inUse} |`,
        `| Pool: available | ${info.poolStats.available} |`,
      );
    }

    lines.push(`| TNS aliases | ${info.tnsAliases.length > 0 ? info.tnsAliases.join(", ") : "(none)"} |`);

    if (info.error) {
      lines.push("", "## Connection Error", "", "```", info.error, "```");
    }

    if (info.tnsAliases.length > 0) {
      lines.push("", "## Available TNS Aliases", "");
      for (const alias of info.tnsAliases) {
        lines.push(`- \`${alias}\``);
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: info,
    };
  })
);

// ================================================================
// Tool 2: db_list_tns
// ================================================================
const ListTnsSchema = z.object({
  file_path: z.string().optional().describe(
    "Optional: explicit path to a tnsnames.ora file. If omitted, auto-searches TNS_ADMIN and ORACLE_HOME/network/admin."
  ),
}).strict();

server.registerTool(
  "db_list_tns",
  {
    title: "List TNS aliases from tnsnames.ora",
    description: `Read and parse the local tnsnames.ora file, returning all available TNS alias names.

Searches in order: TNS_ADMIN directory → ORACLE_HOME/network/admin → current directory.

Args:
  - file_path (string, optional): Explicit path to tnsnames.ora.`,
    inputSchema: ListTnsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  wrapHandler("db_list_tns", async ({ file_path }) => {
    const tnsPath = file_path ?? findTnsNamesPath();

    if (!tnsPath) {
      const cfg = getConfig();
      return {
        content: [
          {
            type: "text",
            text: `tnsnames.ora not found. Searched:\n- TNS_ADMIN: ${cfg.oracle.tnsAdmin ?? "(not set)"}\n- ORACLE_HOME/network/admin: ${cfg.oracle.oracleHome ?? "(not set)"}\n\nTo fix: set TNS_ADMIN to the directory containing tnsnames.ora, or provide an explicit file_path.`,
          },
        ],
        isError: true,
      };
    }

    const aliases = parseTnsAliases(tnsPath);

    if (aliases.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Found tnsnames.ora at \`${tnsPath}\` but no aliases were parsed. The file may be empty or use an unusual format.`,
          },
        ],
      };
    }

    const lines = [
      `# TNS Aliases from \`${tnsPath}\``,
      "",
      `Found ${aliases.length} alias(es):`,
      "",
    ];
    for (const alias of aliases) {
      lines.push(`- \`${alias}\``);
    }
    lines.push("", "To connect using a TNS alias, set `ORACLE_CONNECT_STRING` to the alias name.");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { file: tnsPath, aliases, count: aliases.length },
    };
  })
);

// ================================================================
// Tool 3: db_list_tables
// ================================================================
const ListTablesSchema = z.object({
  owner: z.string().optional().describe(
    "Optional: filter by schema/owner name (case-insensitive). E.g., 'HR', 'APP'. If omitted, lists all non-system schemas."
  ),
}).strict();

server.registerTool(
  "db_list_tables",
  {
    title: "List database tables",
    description: `List all tables in the connected Oracle database (excluding system schemas like SYS, SYSTEM, etc.).

Use this FIRST to discover what tables exist before running queries.

Args:
  - owner (string, optional): Filter by schema/owner name (case-insensitive)`,
    inputSchema: ListTablesSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  wrapHandler("db_list_tables", async ({ owner }) => {
    if (owner) validateIdentifier(owner);
    const tables = await listTables(owner);

    if (tables.length === 0) {
      return {
        content: [{ type: "text", text: owner ? `No tables found for schema '${owner.toUpperCase()}'.` : "No tables found in the database." }],
      };
    }

    const lines = [
      "# Database tables",
      "",
      `Found ${tables.length} table(s):`,
      "",
    ];

    // Group by owner for readability
    const byOwner = new Map<string, string[]>();
    for (const t of tables) {
      if (!byOwner.has(t.owner)) byOwner.set(t.owner, []);
      byOwner.get(t.owner)!.push(t.table);
    }

    for (const [own, tbls] of byOwner) {
      lines.push(`## ${own}`);
      for (const t of tbls) {
        lines.push(`- \`${t}\``);
      }
      lines.push("");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { tables, count: tables.length },
    };
  })
);

// ================================================================
// Tool 4: db_describe_table
// ================================================================
const DescribeTableSchema = z.object({
  table_name: z.string().min(1).max(128).describe(
    "Name of the table to describe (e.g., 'users', 'orders'). Case-insensitive — will be uppercased."
  ),
  owner: z.string().optional().describe(
    "Optional: schema/owner of the table (case-insensitive). Use when the table is in another schema."
  ),
}).strict();

server.registerTool(
  "db_describe_table",
  {
    title: "Describe table schema",
    description: `Get the column structure of a specific Oracle table: column names, data types, data lengths, nullable flag, and default values.

Use this after db_list_tables to understand a table's schema before writing queries.

Args:
  - table_name (string): The table name to inspect (case-insensitive)
  - owner (string, optional): Schema/owner name for cross-schema access`,
    inputSchema: DescribeTableSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  wrapHandler("db_describe_table", async ({ table_name, owner }) => {
    validateIdentifier(table_name);
    if (owner) validateIdentifier(owner);
    const columns = await describeTable(table_name, owner);

    if (columns.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Table '${table_name.toUpperCase()}'${owner ? ` in schema '${owner.toUpperCase()}'` : ""} not found or has no columns.`,
          },
        ],
        isError: true,
      };
    }

    const lines = [
      `# Schema: \`${owner ? owner.toUpperCase() + "." : ""}${table_name.toUpperCase()}\``,
      "",
      "| Column | Type | Length | Nullable | Default |",
      "|--------|------|--------|----------|---------|",
    ];
    for (const col of columns) {
      lines.push(
        `| ${col.column} | ${col.dataType} | ${col.dataLength ?? "-"} | ${col.nullable === "Y" ? "YES" : "NO"} | ${col.defaultValue ?? "-"} |`
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { table: table_name.toUpperCase(), owner: owner?.toUpperCase(), columns },
    };
  })
);

// ================================================================
// Tool 5: db_query (read-only SELECT)
// ================================================================
const QuerySchema = z.object({
  sql: z.string().min(10).max(5000).describe(
    "A read-only SQL query. Must start with SELECT or WITH. Use Oracle bind variables :1, :2, ... for parameters."
  ),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([]).describe(
    "Parameter values for :1, :2, ... bind variables. ALWAYS use these instead of string interpolation to prevent SQL injection."
  ),
  max_rows: z.number().int().min(1).max(500).default(100).describe(
    "Maximum rows to return (default: 100). Results beyond this are truncated."
  ),
}).strict();

server.registerTool(
  "db_query",
  {
    title: "Execute read-only SQL query",
    description: `Execute a read-only SQL query against the Oracle database. Only SELECT and WITH (CTE) statements are allowed.

**IMPORTANT**: Always use Oracle bind variables (:1, :2, ...) instead of string interpolation to prevent SQL injection.

Example:
  sql: "SELECT * FROM users WHERE active = :1 AND created_at > :2"
  params: ["Y", "2024-01-01"]

Safety:
  - Only SELECT/WITH queries allowed (INSERT/UPDATE/DELETE/DROP blocked)
  - Automatic row limit (FETCH FIRST n ROWS ONLY)
  - Query timeout enforced
  - Maximum 500 rows returned

Args:
  - sql (string): Read-only SQL with :1, :2, ... bind variables
  - params (array): Values for bind variables (default: [])
  - max_rows (number): Max rows to return (default: 100, max: 500)`,
    inputSchema: QuerySchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  wrapHandler("db_query", async ({ sql, params, max_rows }) => {
    const result = await executeReadOnlyQuery(sql, params, { maxRows: max_rows });

    if (result.rows.length === 0) {
      return {
        content: [{ type: "text", text: "Query returned 0 rows." }],
      };
    }

    const columns = Object.keys(result.rows[0]);
    const lines = [
      `# Query results (${result.rowCount}${result.truncated ? ` of more, truncated at ${max_rows}` : ""} rows)`,
      "",
      `| ${columns.join(" | ")} |`,
      `| ${columns.map(() => "---").join(" | ")} |`,
    ];

    for (const row of result.rows) {
      lines.push(`| ${columns.map((c) => String(row[c] ?? "NULL")).join(" | ")} |`);
    }

    if (result.truncated) {
      lines.push("", `Results truncated at ${max_rows} rows. Add a tighter WHERE clause or FETCH FIRST to see fewer results.`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        rowCount: result.rowCount,
        truncated: result.truncated,
        columns: result.columns,
        rows: result.rows,
      },
    };
  })
);

// ================================================================
// Tool 6: db_explain_plan
// ================================================================
const ExplainPlanSchema = z.object({
  sql: z.string().min(10).max(5000).describe(
    "A read-only SQL query (SELECT or WITH) to analyze. Must not contain DML/DDL."
  ),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([]).describe(
    "Parameter values for :1, :2, ... bind variables."
  ),
}).strict();

server.registerTool(
  "db_explain_plan",
  {
    title: "Preview execution plan",
    description: `Generate and display the execution plan for a SQL query WITHOUT executing it.

Uses Oracle's EXPLAIN PLAN to show how the query optimizer would run the query: table access methods (FULL SCAN, INDEX RANGE SCAN, etc.), join strategies, and filter predicates.

Use this to understand query performance before running expensive queries.

Args:
  - sql (string): Read-only SQL (SELECT/WITH only) to analyze
  - params (array): Bind variable values (default: [])`,
    inputSchema: ExplainPlanSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  wrapHandler("db_explain_plan", async ({ sql, params }) => {
    const planLines = await getExplainPlan(sql, params);

    if (planLines.length === 0) {
      return {
        content: [{ type: "text", text: "No execution plan was generated. The query may have syntax errors." }],
        isError: true,
      };
    }

    const lines = [
      "# Execution Plan",
      "",
      "```",
      ...planLines,
      "```",
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { plan: planLines },
    };
  })
);

// ================================================================
// Tool 7: db_insert (with dry_run)
// ================================================================
const InsertSchema = z.object({
  table_name: z.string().min(1).max(128).describe("Target table name (e.g., 'users'). Oracle names are uppercase by default."),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).describe(
    'Column-value pairs to insert. Example: {"name": "Alice", "age": 30, "active": true}'
  ),
  dry_run: z.boolean().default(false).describe(
    "If true, return the generated SQL without executing it. Useful for previewing before committing changes."
  ),
}).strict();

server.registerTool(
  "db_insert",
  {
    title: "Insert a record",
    description: `Insert a single record into an Oracle database table using parameterized named binds.

Auto-generates an INSERT with named bind variables from the provided data object. Column names are validated to prevent SQL injection. After insert, the full row is fetched back via ROWID.

**dry_run mode**: Set dry_run=true to preview the generated SQL without executing it.

Example:
  table_name: "users"
  data: { "name": "Alice", "email": "alice@example.com", "active": true }
  dry_run: false

Args:
  - table_name (string): Target table name
  - data (object): Column-value pairs to insert
  - dry_run (boolean): Preview SQL without executing (default: false)`,
    inputSchema: InsertSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  wrapHandler("db_insert", async ({ table_name, data, dry_run }) => {
    validateIdentifier(table_name);
    checkTableAccess(table_name);
    checkDmlAllowed();

    const columns = Object.keys(data);
    if (columns.length === 0) {
      throw new Error("No data provided for insert.");
    }
    for (const col of columns) {
      validateIdentifier(col);
    }

    const columnList = columns.map((c) => c.toUpperCase()).join(", ");
    const placeholders = columns.map((c) => `:${c}`).join(", ");
    const binds: Record<string, unknown> = {};
    for (const col of columns) {
      binds[col] = data[col];
    }

    const sql = `INSERT INTO ${table_name.toUpperCase()} (${columnList}) VALUES (${placeholders})`;

    if (dry_run) {
      return {
        content: [
          {
            type: "text",
            text: `**Dry Run** — SQL generated but not executed:\n\n\`\`\`sql\n${sql}\n\`\`\`\n\nBinds: ${JSON.stringify(binds)}`,
          },
        ],
        structuredContent: { dryRun: true, sql, binds },
      };
    }

    const result = await executeInsertAndReturn(sql, binds as oracledb.BindParameters, table_name.toUpperCase());

    return {
      content: [
        {
          type: "text",
          text: `Inserted ${result.rowsAffected} record(s) into \`${table_name.toUpperCase()}\`.${result.row ? `\n\nInserted row:\n\`\`\`json\n${JSON.stringify(result.row, null, 2)}\n\`\`\`` : ""}`,
        },
      ],
      structuredContent: { inserted: result.rowsAffected, row: result.row },
    };
  })
);

// ================================================================
// Tool 8: db_update (with dry_run + safety cap)
// ================================================================
const UpdateSchema = z.object({
  table_name: z.string().min(1).max(128).describe("Target table name"),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).describe(
    'Column-value pairs to SET. Example: {"status": "active"}'
  ),
  where: z.string().min(1, "WHERE clause is required for safety").max(2000).describe(
    "WHERE clause with named bind variables (:w_1, :w_2, ...). Example: 'id = :w_1 AND status = :w_2'"
  ),
  where_params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).describe(
    "Values for :w_1, :w_2, ... in order. Example: [42, 'inactive']"
  ),
  dry_run: z.boolean().default(false).describe(
    "If true, return the generated SQL and affected row count without executing."
  ),
}).strict();

server.registerTool(
  "db_update",
  {
    title: "Update records",
    description: `Update one or more records in an Oracle database table using parameterized named binds.

Auto-generates the SET clause from the data object. The WHERE clause MUST include named bind variables (:w_1, :w_2, ...) with corresponding where_params.

**Safety features**:
  - WHERE clause is REQUIRED (updates without conditions are blocked)
  - Pre-counts matching rows and refuses if exceeding DML_MAX_ROWS (default: 1000)
  - dry_run mode previews SQL + affected row count

Example:
  table_name: "users"
  data: { "status": "active" }
  where: "id = :w_1"
  where_params: [42]
  dry_run: false

Args:
  - table_name, data, where, where_params, dry_run (default: false)`,
    inputSchema: UpdateSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  wrapHandler("db_update", async ({ table_name, data, where, where_params, dry_run }) => {
    validateIdentifier(table_name);
    checkTableAccess(table_name);
    checkDmlAllowed();

    const setColumns = Object.keys(data);
    if (setColumns.length === 0) {
      throw new Error("No data provided for update.");
    }
    for (const col of setColumns) {
      validateIdentifier(col);
    }

    const setClause = setColumns.map((c) => `${c.toUpperCase()} = :s_${c}`).join(", ");
    const binds: Record<string, unknown> = {};
    for (const col of setColumns) {
      binds[`s_${col}`] = data[col];
    }
    for (let i = 0; i < where_params.length; i++) {
      binds[`w_${i + 1}`] = where_params[i];
    }

    const sql = `UPDATE ${table_name.toUpperCase()} SET ${setClause} WHERE ${where}`;

    // Safety check: count matching rows first
    const matchCount = await countMatchingRows(table_name.toUpperCase(), where, binds as oracledb.BindParameters);
    const cfg = getConfig();
    if (matchCount > cfg.limits.maxDmlRows) {
      throw new Error(
        `Update would affect ${matchCount} row(s), exceeding the safety limit of ${cfg.limits.maxDmlRows}. ` +
        "Add a more specific WHERE clause or increase DML_MAX_ROWS."
      );
    }

    if (dry_run) {
      return {
        content: [
          {
            type: "text",
            text: `**Dry Run** — SQL generated but not executed.\n\nWould affect **${matchCount} row(s)**.\n\n\`\`\`sql\n${sql}\n\`\`\``,
          },
        ],
        structuredContent: { dryRun: true, sql, wouldAffect: matchCount },
      };
    }

    const result = await executeWriteQuery(sql, binds as oracledb.BindParameters);

    return {
      content: [
        {
          type: "text",
          text: `Updated ${result.rowsAffected} row(s) in \`${table_name.toUpperCase()}\` (expected ${matchCount}).`,
        },
      ],
      structuredContent: { updated: result.rowsAffected, expected: matchCount, table: table_name.toUpperCase() },
    };
  })
);

// ================================================================
// Tool 9: db_delete (with dry_run + safety cap)
// ================================================================
const DeleteSchema = z.object({
  table_name: z.string().min(1).max(128).describe("Target table name"),
  where: z.string().min(1, "WHERE clause is required for safety").max(2000).describe(
    "WHERE clause with named bind variables (:w_1, :w_2, ...). Example: 'id = :w_1'"
  ),
  where_params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).describe(
    "Values for :w_1, :w_2, ... in order."
  ),
  dry_run: z.boolean().default(false).describe(
    "If true, return the generated SQL and affected row count without executing."
  ),
}).strict();

server.registerTool(
  "db_delete",
  {
    title: "Delete records",
    description: `Delete one or more records from an Oracle database table using parameterized named binds.

**Safety features**:
  - WHERE clause is REQUIRED (deletes without conditions are blocked)
  - Pre-counts matching rows and refuses if exceeding DML_MAX_ROWS (default: 1000)
  - dry_run mode previews SQL + affected row count

Example:
  table_name: "users"
  where: "id = :w_1 AND status = :w_2"
  where_params: [42, "inactive"]
  dry_run: false`,
    inputSchema: DeleteSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  wrapHandler("db_delete", async ({ table_name, where, where_params, dry_run }) => {
    validateIdentifier(table_name);
    checkTableAccess(table_name);
    checkDmlAllowed();

    const binds: Record<string, unknown> = {};
    for (let i = 0; i < where_params.length; i++) {
      binds[`w_${i + 1}`] = where_params[i];
    }

    const sql = `DELETE FROM ${table_name.toUpperCase()} WHERE ${where}`;

    // Safety check: count matching rows first
    const matchCount = await countMatchingRows(table_name.toUpperCase(), where, binds as oracledb.BindParameters);
    const cfg = getConfig();
    if (matchCount > cfg.limits.maxDmlRows) {
      throw new Error(
        `Delete would affect ${matchCount} row(s), exceeding the safety limit of ${cfg.limits.maxDmlRows}. ` +
        "Add a more specific WHERE clause or increase DML_MAX_ROWS."
      );
    }

    if (dry_run) {
      return {
        content: [
          {
            type: "text",
            text: `**Dry Run** — SQL generated but not executed.\n\nWould delete **${matchCount} row(s)**.\n\n\`\`\`sql\n${sql}\n\`\`\``,
          },
        ],
        structuredContent: { dryRun: true, sql, wouldDelete: matchCount },
      };
    }

    const result = await executeWriteQuery(sql, binds as oracledb.BindParameters);

    return {
      content: [
        {
          type: "text",
          text: `Deleted ${result.rowsAffected} row(s) from \`${table_name.toUpperCase()}\` (expected ${matchCount}).`,
        },
      ],
      structuredContent: { deleted: result.rowsAffected, expected: matchCount, table: table_name.toUpperCase() },
    };
  })
);

// ================================================================
// Tool 10: db_transaction
// ================================================================
const TransactionSchema = z.object({
  steps: z.array(
    z.object({
      sql: z.string().min(5).max(5000).describe("A DML statement (INSERT/UPDATE/DELETE) with bind variables."),
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([]).describe(
        "Bind variable values for :1, :2, ... in this step."
      ),
    })
  ).min(1).max(10).describe("Array of 1-10 DML steps to execute atomically. All succeed or all roll back."),
}).strict();

server.registerTool(
  "db_transaction",
  {
    title: "Execute multi-step transaction",
    description: `Execute multiple DML statements (INSERT/UPDATE/DELETE) in a single atomic transaction.

All steps either succeed and commit together, or fail and roll back together. This ensures data consistency for multi-step operations.

**Limits**: 1-10 steps per transaction. Each step must use Oracle bind variables (:1, :2, ...) — never string interpolation.

Example:
  steps: [
    { sql: "UPDATE accounts SET balance = balance - :1 WHERE id = :2", params: [100, 1] },
    { sql: "UPDATE accounts SET balance = balance + :1 WHERE id = :2", params: [100, 2] },
    { sql: "INSERT INTO transfers (from_id, to_id, amount) VALUES (:1, :2, :3)", params: [1, 2, 100] }
  ]

This is an atomic money transfer: either all three succeed or none do.`,
    inputSchema: TransactionSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  wrapHandler("db_transaction", async ({ steps }) => {
    checkDmlAllowed();
    const result = await executeInTransaction(steps as TransactionStep[]);

    const totalRows = result.results.reduce((sum, r) => sum + r.rowsAffected, 0);
    const lines = [
      "# Transaction Result",
      "",
      `Status: ✅ Committed`,
      `Steps: ${result.results.length}`,
      `Total rows affected: ${totalRows}`,
      "",
      "| Step | Rows | SQL (first 80 chars) |",
      "|------|------|----------------------|",
    ];
    result.results.forEach((r, i) => {
      lines.push(`| ${i + 1} | ${r.rowsAffected} | \`${r.sql.slice(0, 80)}${r.sql.length > 80 ? "..." : ""}\` |`);
    });

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { committed: result.committed, totalRows, results: result.results },
    };
  })
);

// ================================================================
// Tool 11: db_session_info
// ================================================================
server.registerTool(
  "db_session_info",
  {
    title: "Get current session info",
    description: `Retrieve information about the current database session: connected user, schema, instance name, host, database name and version, session ID, NLS date format.

Useful for verifying which database/schema you're connected to and for debugging NLS-related issues.

No parameters required.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  wrapHandler("db_session_info", async () => {
    const info = await getSessionInfo();

    const lines = [
      "# Session Information",
      "",
      "| Property | Value |",
      "|----------|-------|",
      `| Session User | ${info.userName} |`,
      `| Current Schema | ${info.schema} |`,
      `| Instance Name | ${info.instanceName} |`,
      `| Server Host | ${info.hostName} |`,
      `| Database Name | ${info.dbName} |`,
      `| DB Version | ${info.dbVersion} |`,
      `| Session ID | ${info.sid} |`,
      `| Serial # | ${info.serialNum} |`,
      `| Server Type | ${info.server} |`,
      `| Current Time | ${info.currentTime} |`,
      `| NLS Date Format | ${info.nlsDateFormat} |`,
      `| NLS Timestamp Format | ${info.nlsTimestampFormat} |`,
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: info,
    };
  })
);

// ================================================================
// Server startup
// ================================================================
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(
    `Oracle Database MCP server v${config.server.version} started via stdio`
  );
  logger.info(
    `Tools: db_health_check, db_list_tns, db_list_tables, db_describe_table, ` +
    `db_query, db_explain_plan, db_insert, db_update, db_delete, db_transaction, db_session_info`
  );
  logger.info(
    `Config: mode=${config.access.readOnly ? "read-only" : "read-write"}, ` +
    `poolMax=${config.pool.max}, maxRows=${config.limits.maxRows}, ` +
    `dmlMaxRows=${config.limits.maxDmlRows}, ` +
    `rateLimit=${config.rateLimit.enabled ? config.rateLimit.maxRequestsPerMinute + "/min" : "disabled"}, ` +
    `driverMode=${config.oracle.libDir ? "thick" : "thin"}`
  );

  // Initialize pool lazily on first tool call, but log readiness
  logger.info("Connection pool will initialize on first request");

  // Graceful shutdown
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    rateLimiter.close();
    await closePool();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGQUIT", () => shutdown("SIGQUIT"));

  // Uncaught error handler
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", error);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", reason);
  });
}

main().catch((error) => {
  logger.error("Server startup failed", error);
  process.exit(1);
});
