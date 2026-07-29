#!/usr/bin/env node
/**
 * Oracle MCP Server — End-to-End Test Client
 *
 * Sends JSON-RPC 2.0 messages over stdio to the MCP server,
 * simulating how an MCP client (like WorkBuddy) would interact.
 *
 * Usage:
 *   node scripts/test-mcp.mjs                          # Full test suite
 *   node scripts/test-mcp.mjs db_health_check           # Single tool
 *   node scripts/test-mcp.mjs db_query "SELECT * FROM dual"  # With params
 *
 * Environment variables (same as the MCP server):
 *   ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT_STRING, TNS_ADMIN, etc.
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "dist", "index.js");

// ANSI colors for terminal output
const c = {
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};

// ================================================================
// MCP Client: JSON-RPC over stdio
// ================================================================

class McpTestClient {
  constructor(serverPath, env) {
    this.serverPath = serverPath;
    this.env = env;
    this.requestId = 0;
    this.pending = new Map(); // requestId → {resolve, reject, timer}
    this.buffer = "";
    this.process = null;
    this.initialized = false;
  }

  async connect() {
    return new Promise((resolveConn, rejectConn) => {
      this.process = spawn("node", [this.serverPath], {
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process.on("error", rejectConn);

      this.process.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString();
        this._processBuffer();
      });

      this.process.stderr.on("data", (chunk) => {
        // Server logs go to stderr — show them dimmed
        const text = chunk.toString().trim();
        if (text) console.log(c.dim(`  [server] ${text}`));
      });

      this.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          console.log(c.yellow(`  Server exited with code ${code}`));
        }
      });

      // Send initialize request
      this._send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-mcp-client", version: "1.0.0" },
      }).then((result) => {
        // Send initialized notification
        this._sendNotification("notifications/initialized", {});
        this.initialized = true;
        resolveConn(result);
      }).catch(rejectConn);
    });
  }

  _processBuffer() {
    // JSON-RPC messages are delimited by newlines (NDJSON)
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  _handleMessage(msg) {
    // Response to a request
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);

      if (msg.error) {
        reject(new Error(JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
    // Notifications from server (no id) — ignore for now
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method} (id=${id})`));
      }, 30000);

      this.pending.set(id, { resolve, reject, timer });

      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.process.stdin.write(msg + "\n");
    });
  }

  _sendNotification(method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.process.stdin.write(msg + "\n");
  }

  async listTools() {
    return this._send("tools/list", {});
  }

  async callTool(name, args = {}) {
    return this._send("tools/call", { name, arguments: args });
  }

  async disconnect() {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }
}

// ================================================================
// Test Runner
// ================================================================

async function runTests(client, toolFilter) {
  const results = { passed: 0, failed: 0, skipped: 0, tests: [] };

  // ---- Step 1: List all tools ----
  if (!toolFilter || toolFilter === "list") {
    console.log(c.bold("\n📋 Listing all tools...\n"));
    const toolsResult = await client.listTools();
    const tools = toolsResult.tools ?? [];
    console.log(`  Found ${tools.length} tools:\n`);
    for (const t of tools) {
      console.log(`  ${c.cyan("•")} ${t.name} — ${t.description?.split("\n")[0] ?? ""}`);
    }
    results.passed++;
    results.tests.push({ name: "tools/list", status: "passed" });

    if (toolFilter === "list") return results;
  }

  // ---- Step 2: Run individual tool tests ----
  const allTests = [
    {
      name: "db_health_check",
      desc: "Health check: verify driver & connection",
      args: {},
      skipIfError: true, // If this fails, skip remaining DB-dependent tests
    },
    {
      name: "db_list_tns",
      desc: "List TNS aliases from tnsnames.ora",
      args: {},
    },
    {
      name: "db_session_info",
      desc: "Get current session info",
      args: {},
    },
    {
      name: "db_list_tables",
      desc: "List all tables in the database",
      args: {},
    },
    {
      name: "db_query",
      desc: "Query: SELECT * FROM dual",
      args: { sql: "SELECT * FROM dual", params: [], max_rows: 10 },
    },
    {
      name: "db_query",
      desc: "Query: SELECT 1 AS num, 'hello' AS msg FROM dual",
      args: { sql: "SELECT 1 AS num, 'hello' AS msg FROM dual", params: [], max_rows: 10 },
    },
    {
      name: "db_describe_table",
      desc: "Describe: ALL_USERS table",
      args: { table_name: "ALL_USERS" },
    },
    {
      name: "db_explain_plan",
      desc: "Explain plan: SELECT * FROM ALL_USERS",
      args: { sql: "SELECT * FROM ALL_USERS WHERE ROWNUM <= 5", params: [] },
    },
    {
      name: "db_insert",
      desc: "Insert dry-run: TEST_TABLE",
      args: {
        table_name: "TEST_TABLE",
        data: { id: 1, name: "test", created_at: "2024-01-01" },
        dry_run: true,
      },
    },
    {
      name: "db_update",
      desc: "Update dry-run: TEST_TABLE",
      args: {
        table_name: "TEST_TABLE",
        data: { name: "updated" },
        where: "id = :w_1",
        where_params: [1],
        dry_run: true,
      },
    },
    {
      name: "db_delete",
      desc: "Delete dry-run: TEST_TABLE",
      args: {
        table_name: "TEST_TABLE",
        where: "id = :w_1",
        where_params: [1],
        dry_run: true,
      },
    },
    {
      name: "db_transaction",
      desc: "Transaction dry-run: 2-step transfer",
      args: {
        steps: [
          { sql: "UPDATE accounts SET balance = balance - :1 WHERE id = :2", params: [100, 1] },
          { sql: "UPDATE accounts SET balance = balance + :1 WHERE id = :2", params: [100, 2] },
        ],
      },
      // Transaction doesn't have dry_run — this will attempt real execution
      // and fail gracefully if accounts table doesn't exist
      expectError: true,
    },
  ];

  // Filter tests if a specific tool was requested
  let tests = allTests;
  if (toolFilter && toolFilter !== "all") {
    tests = allTests.filter((t) => t.name === toolFilter);
    if (tests.length === 0) {
      console.log(c.red(`  No tests found for tool: ${toolFilter}`));
      console.log(c.dim(`  Available: ${[...new Set(allTests.map((t) => t.name))].join(", ")}`));
      return results;
    }
  }

  // If a raw SQL query was passed (2nd arg after db_query)
  if (toolFilter === "db_query" && process.argv[3]) {
    tests = [{
      name: "db_query",
      desc: `Custom query: ${process.argv[3]}`,
      args: { sql: process.argv[3], params: [], max_rows: 100 },
    }];
  }

  let dbConnectionFailed = false;

  for (const test of tests) {
    if (dbConnectionFailed && test.name !== "db_health_check") {
      results.skipped++;
      results.tests.push({ name: test.desc, status: "skipped", reason: "DB connection failed" });
      continue;
    }

    console.log(c.bold(`\n🧪 ${test.name}`) + c.dim(` — ${test.desc}`));
    console.log(c.dim(`  Args: ${JSON.stringify(test.args).slice(0, 120)}${JSON.stringify(test.args).length > 120 ? "..." : ""}`));

    try {
      const result = await client.callTool(test.name, test.args);

      if (result.isError) {
        if (test.expectError) {
          console.log(c.green("  ✓ Passed (expected error)"));
          results.passed++;
          results.tests.push({ name: test.desc, status: "passed" });
        } else {
          const errorText = result.content?.[0]?.text ?? "Unknown error";
          console.log(c.red(`  ✗ Failed: ${errorText.slice(0, 200)}`));
          results.failed++;
          results.tests.push({ name: test.desc, status: "failed", error: errorText });

          if (test.name === "db_health_check" && test.skipIfError) {
            console.log(c.yellow("  ⚠ DB connection failed — skipping remaining DB-dependent tests"));
            dbConnectionFailed = true;
          }
        }
      } else {
        const text = result.content?.[0]?.text ?? "(no text content)";
        // Show first 500 chars of result
        const preview = text.slice(0, 500);
        console.log(c.green("  ✓ Passed"));
        console.log(c.dim(`  Response preview:`));
        console.log(c.dim(`  ${preview.split("\n").join("\n  ")}`));
        if (text.length > 500) console.log(c.dim(`  ... (${text.length - 500} more chars)`));
        results.passed++;
        results.tests.push({ name: test.desc, status: "passed" });
      }
    } catch (error) {
      const errMsg = error.message?.slice(0, 200) ?? String(error);
      console.log(c.red(`  ✗ Error: ${errMsg}`));
      results.failed++;
      results.tests.push({ name: test.desc, status: "error", error: errMsg });

      if (test.name === "db_health_check" && test.skipIfError) {
        dbConnectionFailed = true;
      }
    }
  }

  return results;
}

// ================================================================
// Main
// ================================================================

async function main() {
  // Check env vars
  const required = ["ORACLE_USER", "ORACLE_PASSWORD", "ORACLE_CONNECT_STRING"];
  const missing = required.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    console.log(c.bold("Oracle MCP Server — Test Client\n"));
    console.log(c.red("Missing required environment variables: " + missing.join(", ")));
    console.log(c.dim("\nSet them before running:"));
    console.log(c.dim(`  export ORACLE_USER=hr`));
    console.log(c.dim(`  export ORACLE_PASSWORD=yourpass`));
    console.log(c.dim(`  export ORACLE_CONNECT_STRING=localhost:1521/ORCLPDB1`));
    console.log(c.dim(`\nOr create a .env file and use: node --env-file=.env scripts/test-mcp.mjs`));
    process.exit(1);
  }

  console.log(c.bold("\n" + "=".repeat(60)));
  console.log(c.bold("  Oracle MCP Server — End-to-End Test Client"));
  console.log(c.bold("=".repeat(60)));
  console.log(c.dim(`  Server: ${SERVER_PATH}`));
  console.log(c.dim(`  DB: ${process.env.ORACLE_USER}@${process.env.ORACLE_CONNECT_STRING}`));
  console.log(c.dim(`  Mode: ${process.env.ORACLE_CLIENT_DIR ? "thick" : "thin"}`));

  const toolFilter = process.argv[2] ?? "all";

  const client = new McpTestClient(SERVER_PATH, {});

  try {
    console.log(c.bold("\n🔌 Connecting to MCP server...\n"));
    const initResult = await client.connect();
    console.log(c.green("  ✓ Connected"));
    console.log(c.dim(`  Server: ${initResult.serverInfo?.name} v${initResult.serverInfo?.version}`));
    console.log(c.dim(`  Protocol: ${initResult.protocolVersion}`));

    const results = await runTests(client, toolFilter);

    // Summary
    console.log(c.bold("\n" + "=".repeat(60)));
    console.log(c.bold("  Test Summary"));
    console.log(c.bold("=".repeat(60)));
    console.log(`  ${c.green("Passed:")} ${results.passed}`);
    console.log(`  ${c.red("Failed:")} ${results.failed}`);
    if (results.skipped > 0) {
      console.log(`  ${c.yellow("Skipped:")} ${results.skipped}`);
    }
    console.log();

    // Detailed failures
    const failures = results.tests.filter((t) => t.status === "failed" || t.status === "error");
    if (failures.length > 0) {
      console.log(c.red("  Failures:"));
      for (const f of failures) {
        console.log(c.red(`    • ${f.name}: ${(f.error ?? "").slice(0, 150)}`));
      }
      console.log();
    }

    await client.disconnect();

    process.exit(results.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error(c.red(`\nFatal error: ${error.message}`));
    await client.disconnect();
    process.exit(1);
  }
}

main();
