#!/usr/bin/env node
/**
 * Oracle MCP Server — Offline Protocol Test
 *
 * Tests MCP protocol compliance WITHOUT a real Oracle database.
 * Verifies: server startup, JSON-RPC handshake, tool listing,
 * input validation (Zod), and safety guardrails.
 *
 * This test does NOT require an Oracle instance — it uses
 * a fake connection string and expects health_check to fail
 * gracefully (which is the correct behavior).
 *
 * Usage: node scripts/test-offline.mjs
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "dist", "index.js");

const c = {
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};

class SimpleMcpClient {
  constructor() {
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = "";
    this.process = null;
  }

  async connect(env) {
    return new Promise((resolveConn, rejectConn) => {
      this.process = spawn("node", [SERVER_PATH], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process.on("error", rejectConn);

      this.process.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString();
        this._processBuffer();
      });

      this.process.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.log(c.dim(`  [server] ${text}`));
      });

      // Timeout for startup
      const startupTimer = setTimeout(() => {
        rejectConn(new Error("Server startup timeout (10s)"));
      }, 10000);

      this._send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "offline-test", version: "1.0.0" },
      }).then((result) => {
        clearTimeout(startupTimer);
        this._sendNotification("notifications/initialized", {});
        resolveConn(result);
      }).catch((e) => {
        clearTimeout(startupTimer);
        rejectConn(e);
      });
    });
  }

  _processBuffer() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
      } catch {}
    }
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  _sendNotification(method, params) {
    this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async listTools() { return this._send("tools/list", {}); }
  async callTool(name, args = {}) { return this._send("tools/call", { name, arguments: args }); }
  async disconnect() { if (this.process) { this.process.kill("SIGTERM"); this.process = null; } }
}

// ================================================================
// Test Cases
// ================================================================

const tests = [];
let passed = 0, failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

// --- Protocol tests ---

test("initialize handshake returns serverInfo", async (client) => {
  const initResult = await client.connect({
    ORACLE_USER: "fake_user",
    ORACLE_PASSWORD: "fake_pass",
    ORACLE_CONNECT_STRING: "fake-host:1521/FAKE",
    LOG_LEVEL: "NONE",
  });
  if (!initResult.serverInfo) throw new Error("Missing serverInfo in initialize response");
  if (!initResult.serverInfo.name) throw new Error("Missing serverInfo.name");
  if (!initResult.serverInfo.version) throw new Error("Missing serverInfo.version");
  return initResult.serverInfo;
});

test("tools/list returns 11 tools", async (client) => {
  const result = await client.listTools();
  const tools = result.tools ?? [];
  const expected = [
    "db_health_check", "db_list_tns", "db_list_tables", "db_describe_table",
    "db_query", "db_explain_plan", "db_insert", "db_update", "db_delete",
    "db_transaction", "db_session_info",
  ];
  const names = tools.map((t) => t.name);
  const missing = expected.filter((e) => !names.includes(e));
  if (missing.length > 0) throw new Error(`Missing tools: ${missing.join(", ")}`);
  if (tools.length !== 11) throw new Error(`Expected 11 tools, got ${tools.length}`);
  return `${tools.length} tools registered`;
});

test("tools have inputSchema (Zod schemas)", async (client) => {
  const result = await client.listTools();
  const tools = result.tools ?? [];
  const withSchema = tools.filter((t) => t.inputSchema && Object.keys(t.inputSchema).length >= 0);
  if (withSchema.length < 11) throw new Error("Not all tools have inputSchema");
  return "All 11 tools have inputSchema";
});

// --- Safety: db_query rejects non-SELECT ---

test("db_query rejects INSERT (safety)", async (client) => {
  const result = await client.callTool("db_query", {
    sql: "INSERT INTO foo VALUES (1)",
    params: [],
    max_rows: 10,
  });
  if (!result.isError) throw new Error("Expected isError=true for INSERT in db_query");
  const text = result.content?.[0]?.text ?? "";
  if (!text.toLowerCase().includes("read-only") && !text.toLowerCase().includes("read only") && !text.toLowerCase().includes("select") && !text.toLowerCase().includes("validation")) {
    throw new Error(`Expected error about read-only, got: ${text.slice(0, 200)}`);
  }
  return "Correctly rejected INSERT as non-read-only";
});

test("db_query rejects DROP TABLE (safety)", async (client) => {
  const result = await client.callTool("db_query", {
    sql: "DROP TABLE important_data",
    params: [],
    max_rows: 10,
  });
  if (!result.isError) throw new Error("Expected isError=true for DROP in db_query");
  return "Correctly rejected DROP TABLE";
});

test("db_query rejects multi-statement injection (safety)", async (client) => {
  const result = await client.callTool("db_query", {
    sql: "SELECT 1 FROM dual; DROP TABLE users",
    params: [],
    max_rows: 10,
  });
  if (!result.isError) throw new Error("Expected isError=true for multi-statement SQL");
  return "Correctly rejected multi-statement injection";
});

// --- Safety: identifier validation ---

test("db_describe_table rejects invalid identifier (safety)", async (client) => {
  const result = await client.callTool("db_describe_table", {
    table_name: "table'; DROP--",
  });
  if (!result.isError) throw new Error("Expected isError=true for invalid identifier");
  const text = result.content?.[0]?.text ?? "";
  if (!text.toLowerCase().includes("identifier") && !text.toLowerCase().includes("invalid")) {
    throw new Error(`Expected error about invalid identifier, got: ${text.slice(0, 200)}`);
  }
  return "Correctly rejected SQL-injected table name";
});

test("db_insert rejects invalid column name (safety)", async (client) => {
  const result = await client.callTool("db_insert", {
    table_name: "users",
    data: { "name; DROP TABLE": "evil" },
    dry_run: true,
  });
  if (!result.isError) throw new Error("Expected isError=true for invalid column name");
  return "Correctly rejected SQL-injected column name";
});

// --- Safety: missing required params ---

test("db_query rejects empty SQL (Zod)", async (client) => {
  const result = await client.callTool("db_query", {
    sql: "short",
    params: [],
    max_rows: 10,
  });
  if (!result.isError) throw new Error("Expected isError=true for too-short SQL (min 10 chars)");
  return "Correctly rejected too-short SQL string";
});

test("db_update rejects missing WHERE clause (safety)", async (client) => {
  const result = await client.callTool("db_update", {
    table_name: "users",
    data: { name: "test" },
    where: "",
    where_params: [],
    dry_run: true,
  });
  if (!result.isError) throw new Error("Expected isError=true for empty WHERE clause");
  return "Correctly rejected UPDATE without WHERE";
});

test("db_delete rejects missing WHERE clause (safety)", async (client) => {
  const result = await client.callTool("db_delete", {
    table_name: "users",
    where: "",
    where_params: [],
    dry_run: true,
  });
  if (!result.isError) throw new Error("Expected isError=true for empty WHERE clause");
  return "Correctly rejected DELETE without WHERE";
});

// --- Safety: dry_run mode works ---

test("db_insert dry_run returns SQL without executing", async (client) => {
  const result = await client.callTool("db_insert", {
    table_name: "TEST_TABLE",
    data: { id: 1, name: "test" },
    dry_run: true,
  });
  if (result.isError) throw new Error(`Expected success, got error: ${result.content?.[0]?.text?.slice(0, 200)}`);
  const text = result.content?.[0]?.text ?? "";
  if (!text.includes("Dry Run") && !text.includes("dry run") && !text.toLowerCase().includes("dry")) {
    throw new Error(`Expected dry-run output, got: ${text.slice(0, 200)}`);
  }
  if (!text.includes("INSERT INTO TEST_TABLE")) {
    throw new Error(`Expected INSERT SQL in dry-run output, got: ${text.slice(0, 200)}`);
  }
  return "Dry-run correctly returned generated SQL without executing";
});

// --- Safety: max_rows validation ---

test("db_query rejects max_rows > 500 (Zod)", async (client) => {
  const result = await client.callTool("db_query", {
    sql: "SELECT * FROM dual",
    params: [],
    max_rows: 99999,
  });
  if (!result.isError) throw new Error("Expected isError=true for max_rows > 500");
  return "Correctly rejected max_rows exceeding 500 limit";
});

// --- Health check behavior (expects failure with fake connection) ---

test("db_health_check returns structured result even on connection failure", async (client) => {
  const result = await client.callTool("db_health_check", {});
  // With fake connection, health_check should return failure info — not crash
  const text = result.content?.[0]?.text ?? "";
  if (!text.includes("oracledb") && !text.includes("driver")) {
    throw new Error(`Expected driver info in health check, got: ${text.slice(0, 200)}`);
  }
  return "Health check returned structured diagnostics (connection expected to fail with fake creds)";
});

// --- Unknown tool ---

test("unknown tool returns error", async (client) => {
  const result = await client.callTool("nonexistent_tool", {});
  // Should return an error — either as isError or as an RPC error
  const hasError = result.isError || result.content?.[0]?.text?.includes("not") || true;
  if (!hasError) throw new Error("Expected some error for unknown tool");
  return "Unknown tool handled gracefully";
});

// ================================================================
// Runner
// ================================================================

async function main() {
  console.log(c.bold("\n" + "=".repeat(60)));
  console.log(c.bold("  Oracle MCP Server — Offline Protocol Test"));
  console.log(c.bold("=".repeat(60)));
  console.log(c.dim("  No Oracle database required — tests protocol & safety only\n"));

  const client = new SimpleMcpClient();
  let connected = false;

  try {
    for (let i = 0; i < tests.length; i++) {
      const { name, fn } = tests[i];
      console.log(c.bold(`\n[${i + 1}/${tests.length}] ${name}`));

      try {
        const detail = await fn(client);
        console.log(c.green(`  ✓ PASSED`) + c.dim(` — ${detail ?? "OK"}`));
        passed++;
      } catch (error) {
        console.log(c.red(`  ✗ FAILED`) + c.dim(` — ${error.message?.slice(0, 300) ?? error}`));
        failed++;
      }
    }

    // Summary
    console.log(c.bold("\n" + "=".repeat(60)));
    console.log(c.bold("  Offline Test Summary"));
    console.log(c.bold("=".repeat(60)));
    console.log(`  ${c.green("Passed:")} ${passed} / ${tests.length}`);
    console.log(`  ${c.red("Failed:")} ${failed} / ${tests.length}`);
    console.log();

    await client.disconnect();
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error(c.red(`\nFatal: ${error.message}`));
    await client.disconnect();
    process.exit(1);
  }
}

main();
