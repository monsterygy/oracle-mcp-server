#!/usr/bin/env node
/**
 * Test: npx github:monsterygy/oracle-mcp-server
 * Verifies that the GitHub-based npx approach works (prepare script auto-builds).
 */
import { spawn } from "child_process";

const child = spawn("npx", ["-y", "github:monsterygy/oracle-mcp-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ORACLE_USER: "fake_user",
    ORACLE_PASSWORD: "fake_pass",
    ORACLE_CONNECT_STRING: "localhost:1521/FAKE",
    LOG_LEVEL: "ERROR",
  },
});

let stdout = "";
let stderr = "";
let step = 0;

const tests = [
  {
    name: "initialize",
    req: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } },
  },
  {
    name: "tools/list",
    req: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  },
];

function sendNext() {
  if (step >= tests.length) {
    console.log("\n=== GitHub npx Test Summary ===");
    console.log("PASSED: All tests completed");
    child.kill();
    process.exit(0);
  }
  const test = tests[step];
  console.log(`\n[${step + 1}/${tests.length}] Sending ${test.name}...`);
  child.stdin.write(JSON.stringify(test.req) + "\n");
}

child.stdout.on("data", (data) => {
  stdout += data.toString();
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) {
        const test = tests[step];
        console.log(`  ✓ Got response for ${test.name} (id=${msg.id})`);
        if (test.name === "initialize" && msg.result?.serverInfo) {
          console.log(`    Server: ${msg.result.serverInfo.name} v${msg.result.serverInfo.version}`);
        }
        if (test.name === "tools/list" && msg.result?.tools) {
          console.log(`    Tools: ${msg.result.tools.length} registered`);
        }
        step++;
        sendNext();
        return;
      }
    } catch {
      // not JSON, ignore
    }
  }
});

child.stderr.on("data", (data) => {
  stderr += data.toString();
  // Show progress (npx download, build, etc.)
  process.stderr.write(data);
});

child.on("error", (err) => {
  console.error("FAILED: spawn error:", err.message);
  process.exit(1);
});

// Timeout after 120 seconds (first npx download + build takes time)
setTimeout(() => {
  console.error("\nFAILED: Timeout after 120s");
  console.error("stdout:", stdout.slice(0, 500));
  console.error("stderr:", stderr.slice(0, 500));
  child.kill();
  process.exit(1);
}, 120000);

console.log("Testing: npx github:monsterygy/oracle-mcp-server");
console.log("(First run will download + build, please wait...)\n");

// Start with initialize
sendNext();
