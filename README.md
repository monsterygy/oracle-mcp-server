# Oracle Database MCP Server — Production Edition

A production-grade [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for Oracle database interaction, providing 11 tools for full CRUD, transactions, execution plans, and comprehensive safety guardrails.

> **拿来即用** — 无需 clone、无需手动 build。配置好 mcp.json 就能用。

## Features

### 11 Tools

| Tool | Purpose | Read/Write | Safety |
|------|---------|-----------|--------|
| `db_health_check` | Verify driver & connection diagnostics | Read | — |
| `db_list_tns` | Parse tnsnames.ora aliases | Read | — |
| `db_list_tables` | List all tables (optional schema filter) | Read | — |
| `db_describe_table` | Get column schema of a table | Read | — |
| `db_query` | Execute read-only SQL (SELECT/WITH) | Read | Read-only enforced |
| `db_explain_plan` | Preview execution plan without running | Read | — |
| `db_insert` | Insert a record (with dry_run) | Write | Identifier validation |
| `db_update` | Update records matching WHERE (with dry_run) | Write | Safety row cap |
| `db_delete` | Delete records matching WHERE (with dry_run) | Write | Safety row cap |
| `db_transaction` | Multi-step atomic transaction | Write | All-or-nothing |
| `db_session_info` | Current session/privilege info | Read | — |

### Production-Grade Features

- **Centralized config validation** — Fails fast on missing env vars at startup
- **Structured logging** — Request IDs, log levels (DEBUG/INFO/WARN/ERROR), JSON or text format
- **Custom error types** — ConnectionError, QueryError, ValidationError, TimeoutError, RateLimitError, AccessDeniedError with error codes
- **Rate limiting** — Sliding window, configurable per-minute cap
- **Connection retry** — Exponential backoff for transient failures (ORA-03113, TNS errors)
- **Pool resilience** — Health check, dead connection detection, automatic reinitialization
- **Table whitelist/blacklist** — Configurable table-level access control
- **Read-only mode** — Optional flag to block all DML operations
- **DML safety cap** — Pre-counts matching rows, refuses if exceeding `DML_MAX_ROWS`
- **Dry-run mode** — Preview generated SQL without executing for INSERT/UPDATE/DELETE
- **Oracle type conversion** — DATE, TIMESTAMP, CLOB, BLOB → JSON-serializable values
- **SQL injection prevention** — Parameterized binds, identifier validation, multi-statement blocking
- **Unit tested** — 42 tests covering all security boundary functions

---

## Quick Start

三种方式，按需选择：

### 方式一：GitHub npx（最简单，推荐给同事）

无需 clone、无需手动 build。`prepare` 脚本会自动编译。

```bash
npx -y github:monsterygy/oracle-mcp-server
```

MCP 客户端配置（同事拿到这段 JSON 填上账号密码即可）：

```json
{
  "mcpServers": {
    "oracle-db": {
      "command": "npx",
      "args": ["-y", "github:monsterygy/oracle-mcp-server"],
      "env": {
        "ORACLE_USER": "hr",
        "ORACLE_PASSWORD": "yourpass",
        "ORACLE_CONNECT_STRING": "localhost:1521/ORCLPDB1"
      }
    }
  }
}
```

> 首次启动会从 GitHub 下载并自动编译（约 30 秒），之后使用缓存秒启。

### 方式二：离线 Tarball（适合内网/无外网环境）

**打包**（你执行一次，生成 `.tgz` 文件）：

```bash
cd database-mcp-server
npm pack
# → 生成 gy-oracle-database-mcp-server-3.1.0.tgz（约 45KB）
```

**安装**（同事拿到 `.tgz` 文件后执行）：

```bash
npm install -g gy-oracle-database-mcp-server-3.1.0.tgz
# → 全局安装，gy-oracle-mcp-server 命令可用
```

MCP 客户端配置（使用全局安装的命令，无需 npx）：

```json
{
  "mcpServers": {
    "oracle-db": {
      "command": "gy-oracle-mcp-server",
      "env": {
        "ORACLE_USER": "hr",
        "ORACLE_PASSWORD": "yourpass",
        "ORACLE_CONNECT_STRING": "localhost:1521/ORCLPDB1"
      }
    }
  }
}
```

### 方式三：Clone & Build（开发调试用）

```bash
git clone https://github.com/monsterygy/oracle-mcp-server.git
cd oracle-mcp-server
npm install      # prepare 脚本自动 build
npm start
```

本地路径方式配置：

```json
{
  "mcpServers": {
    "oracle-db": {
      "command": "node",
      "args": ["/absolute/path/to/oracle-mcp-server/dist/index.js"],
      "env": {
        "ORACLE_USER": "hr",
        "ORACLE_PASSWORD": "yourpass",
        "ORACLE_CONNECT_STRING": "localhost:1521/ORCLPDB1"
      }
    }
  }
}
```

---

## Integrate with MCP Clients

### WorkBuddy / ccswitch

Add to `~/.workbuddy/mcp.json`:

```json
{
  "mcpServers": {
    "oracle-db": {
      "command": "npx",
      "args": ["-y", "github:monsterygy/oracle-mcp-server"],
      "env": {
        "ORACLE_USER": "hr",
        "ORACLE_PASSWORD": "yourpass",
        "ORACLE_CONNECT_STRING": "localhost:1521/ORCLPDB1",
        "LOG_LEVEL": "INFO",
        "DML_MAX_ROWS": "1000"
      }
    }
  }
}
```

After saving, open the connector management page and click **Trust** to enable.

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "oracle-db": {
      "command": "npx",
      "args": ["-y", "github:monsterygy/oracle-mcp-server"],
      "env": {
        "ORACLE_USER": "hr",
        "ORACLE_PASSWORD": "yourpass",
        "ORACLE_CONNECT_STRING": "localhost:1521/ORCLPDB1"
      }
    }
  }
}
```

### Cursor / VS Code (with MCP support)

Add to `.cursor/mcp.json` or VS Code MCP settings:

```json
{
  "mcpServers": {
    "oracle-db": {
      "command": "npx",
      "args": ["-y", "github:monsterygy/oracle-mcp-server"],
      "env": {
        "ORACLE_USER": "hr",
        "ORACLE_PASSWORD": "yourpass",
        "ORACLE_CONNECT_STRING": "localhost:1521/ORCLPDB1"
      }
    }
  }
}
```

### Debug with MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx -y github:monsterygy/oracle-mcp-server
```

Or with a local clone:

```bash
npm run inspector
```

---

## Configuration

All configuration is managed via environment variables. See `.env.example` for the full list.

### Minimum Required

```env
ORACLE_USER=hr
ORACLE_PASSWORD=your_password
ORACLE_CONNECT_STRING=localhost:1521/ORCLPDB1
```

### Connection Methods

#### Method 1: EZ Connect (simplest)

```env
ORACLE_CONNECT_STRING=localhost:1521/ORCLPDB1
```

#### Method 2: TNS Alias

```env
ORACLE_CONNECT_STRING=ORCLPDB1
TNS_ADMIN=/path/to/oracle/network/admin
```

#### Method 3: Full TNS Descriptor

```env
ORACLE_CONNECT_STRING=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=localhost)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCLPDB1)))
```

### Driver Modes

| Mode | Requirement | Use When |
|------|------------|----------|
| **Thin** (default) | None (pure JS) | Oracle 12.1+ |
| **Thick** | Oracle Instant Client | Oracle 11g, advanced features |

To use thick mode:

```env
ORACLE_CLIENT_DIR=/path/to/instantclient_19_22
```

### Safety Configuration

```env
# Query limits
QUERY_MAX_ROWS=500           # Max rows returned by db_query
QUERY_TIMEOUT_MS=10000       # Query timeout in ms
DML_MAX_ROWS=1000            # Max rows DML can affect (safety cap)

# Access control
ALLOWED_TABLES=USERS,ORDERS # Whitelist (comma-separated, uppercase)
BLOCKED_TABLES=AUDIT_LOG    # Blacklist
READ_ONLY_MODE=false        # Block all DML if true

# Rate limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_PER_MINUTE=60

# Logging
LOG_LEVEL=INFO               # DEBUG | INFO | WARN | ERROR | NONE
LOG_JSON=false              # JSON-structured logs if true
```

## Docker

### Quick Start with Oracle XE

```bash
docker-compose up -d
```

This starts:

- Oracle XE 21c (gvenzl/oracle-xe:21-slim) on port 1521
- MCP server connected to the Oracle XE instance

### Custom Oracle Instance

```bash
docker build -t oracle-mcp-server .
docker run -i --rm \
  -e ORACLE_USER=hr \
  -e ORACLE_PASSWORD=yourpass \
  -e ORACLE_CONNECT_STRING=your-host:1521/your-service \
  oracle-mcp-server
```

## Security Architecture

```
Request → [Rate Limiter] → [Zod Input Validation] → [Identifier Validation]
  → [Table Whitelist/Blacklist] → [Read-Only Check (for DML)]
  → [DML Safety Cap (pre-count)] → [Bind Variables (:1, :2)]
  → [Query Timeout] → [Row Limit (FETCH FIRST)] → Oracle DB
```

| Security Layer | Implementation | Defends Against |
|---------------|----------------|-----------------|
| Zod schema validation | `.strict()` + constraints | Invalid input, missing params |
| Identifier regex | `^[a-zA-Z_][a-zA-Z0-9_]{0,127}$` | SQL injection via table/column names |
| Table whitelist/blacklist | `ALLOWED_TABLES` / `BLOCKED_TABLES` | Unauthorized table access |
| Read-only enforcement | Regex check for SELECT/WITH only | DML/DDL in db_query |
| Multi-statement blocking | Semicolon detection | Statement injection |
| Parameterized binds | `:1, :2` / named binds | SQL injection in values |
| DML safety cap | Pre-count + `DML_MAX_ROWS` | Mass UPDATE/DELETE |
| Query timeout | `Promise.race` with timer | Slow queries |
| Row limit | `FETCH FIRST n ROWS ONLY` | Result set overflow |
| Rate limiting | Sliding window | Abuse / DoS |

## Development

```bash
# Run in dev mode with auto-reload
npm run dev

# Lint
npm run lint
```

## Testing

Three layers of testing are provided:

### 1. Unit Tests (42 tests, no DB needed)

Tests pure security functions: `isReadOnlyQuery`, `validateIdentifier`, `applyRowLimit`, `isTableAllowed`, `parseTnsAliasesContent`.

```bash
npm test                    # Run all unit tests
npm run test:watch         # Watch mode (re-runs on file change)
npm run test:coverage       # With coverage report
```

### 2. Offline Protocol Tests (15 tests, no DB needed)

Tests the full MCP JSON-RPC handshake, tool listing, and safety guardrails (SQL injection rejection, input validation, dry-run mode) — all without an Oracle database.

```bash
npm run test:offline
```

This launches the MCP server with fake credentials and verifies:

- JSON-RPC `initialize` handshake succeeds
- `tools/list` returns all 11 tools with `inputSchema`
- `db_query` rejects INSERT/DROP/multi-statement injection
- `db_insert` rejects SQL-injected column names
- `db_update`/`db_delete` reject missing WHERE clauses
- `db_insert` dry-run returns SQL without executing
- `db_query` rejects `max_rows > 500` (Zod validation)
- `db_health_check` returns structured diagnostics even on connection failure

### 3. End-to-End Tests (requires Oracle DB)

Sends real JSON-RPC tool calls to the MCP server connected to your Oracle database.

```bash
# Set env vars first
export ORACLE_USER=hr
export ORACLE_PASSWORD=yourpass
export ORACLE_CONNECT_STRING=localhost:1521/ORCLPDB1

# Run full e2e test suite
npm run test:e2e

# Or test a single tool
node scripts/test-mcp.mjs db_health_check
node scripts/test-mcp.mjs db_list_tables
node scripts/test-mcp.mjs db_query "SELECT * FROM dual"

# Or just list all available tools
node scripts/test-mcp.mjs list
```

### 4. MCP Inspector (interactive GUI)

```bash
npx @modelcontextprotocol/inspector npx -y github:monsterygy/oracle-mcp-server
```

Opens a web UI at `http://localhost:5173` where you can:

- View all 11 tool schemas
- Call any tool with custom parameters
- See raw JSON-RPC request/response
- Debug connection issues

## Project Structure

```
oracle-mcp-server/
├── src/
│   ├── config.ts          # Centralized config validation
│   ├── logger.ts          # Structured logging with request IDs
│   ├── errors.ts          # Custom error types with codes
│   ├── rateLimiter.ts     # Sliding window rate limiter
│   ├── security.ts        # Pure security functions (unit-tested)
│   ├── db.ts              # Oracle connection pool & query execution
│   ├── index.ts           # MCP server & tool registration
│   └── __tests__/
│       └── security.test.ts  # 42 unit tests
├── scripts/
│   ├── test-offline.mjs   # 15 offline protocol tests (no DB)
│   ├── test-mcp.mjs       # End-to-end tests (requires DB)
│   └── test-github-npx.mjs # GitHub npx verification test
├── Dockerfile             # Multi-stage build
├── docker-compose.yml    # Oracle XE + MCP server
├── .eslintrc.json        # Code quality rules
├── .env.example          # Configuration template
└── package.json
```

## Local Sharing (npm pack)

Generate a shareable tarball for colleagues (no npm registry needed):

```bash
npm pack
# → gy-oracle-database-mcp-server-3.1.0.tgz (≈45KB)
```

Colleagues install it:

```bash
npm install -g gy-oracle-database-mcp-server-3.1.0.tgz
# → gy-oracle-mcp-server 命令全局可用
```

## License

MIT
