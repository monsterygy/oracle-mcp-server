# 本地测试指南

## 前提条件

```bash
# 确保已安装依赖 + 编译
cd database-mcp-server
npm install
npm run build
```

---

## 方式一：MCP Inspector（可视化 GUI，最推荐）

**不需要 Oracle 数据库**，可视化查看所有工具和 schema：

```bash
npm run inspector
```

这会启动一个本地 Web 服务，自动打开浏览器。你可以在界面里：
- 查看所有 11 个工具的参数 schema
- 手动调用工具并查看返回
- 查看 JSON-RPC 原始通信

> Inspector 会用假的环境变量启动 Server，协议握手和工具列表不需要真实数据库。
> 调用 `db_health_check` 等需要数据库的工具会报连接错误，这是正常的。

---

## 方式二：离线协议测试（无需数据库）

验证 MCP 协议握手 + 安全防线（15 个测试）：

```bash
npm run test:offline
```

输出示例：
```
✅ 1/15  Initialize handshake
✅ 2/15  List tools (expect 11 tools)
✅ 3/15  db_query rejects INSERT
✅ 4/15  db_query rejects DROP TABLE
✅ 5/15  db_query rejects multi-statement injection
...
✅ 15/15 db_update requires WHERE clause
Result: 15/15 passed
```

---

## 方式三：连接真实 Oracle 数据库测试

### 第 1 步：创建 .env 文件

```bash
cp .env.example .env
```

编辑 `.env`，填入你的 Oracle 连接信息：

```env
ORACLE_USER=your_user
ORACLE_PASSWORD=your_password
ORACLE_CONNECT_STRING=localhost:1521/ORCLPDB1
LOG_LEVEL=DEBUG
```

### 第 2 步：用 Docker 快速启动 Oracle XE（如果没有 Oracle 环境）

```bash
docker-compose up -d oracle-xe
# 等待 ~30 秒 Oracle 启动完成
# 默认用户: system / oracle, SID: XE, PDB: XEPDB1
```

### 第 3 步：端到端测试

```bash
# 跑全部工具测试
npm run test:e2e

# 或测试单个工具
node scripts/test-mcp.mjs db_health_check
node scripts/test-mcp.mjs db_list_tables
node scripts/test-mcp.mjs db_query "SELECT * FROM dual"
node scripts/test-mcp.mjs list          # 列出所有工具
```

---

## 方式四：在 WorkBuddy 中集成使用

### 第 1 步：配置 MCP

编辑 `~/.workbuddy/mcp.json`，添加：

```json
{
  "mcpServers": {
    "oracle-db": {
      "command": "node",
      "args": ["D:/Program Files/workBuddySave/2026-07-29-09-39-22/database-mcp-server/dist/index.js"],
      "env": {
        "ORACLE_USER": "your_user",
        "ORACLE_PASSWORD": "your_password",
        "ORACLE_CONNECT_STRING": "localhost:1521/ORCLPDB1",
        "LOG_LEVEL": "INFO",
        "READ_ONLY_MODE": "false"
      }
    }
  }
}
```

### 第 2 步：启用连接器

打开 WorkBuddy → 右上角连接器管理 → 找到 `oracle-db` → 点击 **Trust**

### 第 3 步：在对话中使用

连接成功后，直接在对话中说：
- "列出 Oracle 数据库所有表"
- "查看 USERS 表结构"
- "查询 orders 表前 10 行"
- "往 users 表插入一条记录"

---

## 方式五：直接用命令行测试（最快验证）

```bash
cd database-mcp-server

# 发送一条 JSON-RPC 请求测试
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | ORACLE_USER=test ORACLE_PASSWORD=test ORACLE_CONNECT_STRING=localhost:1521/ORCLPDB1 \
  node dist/index.js 2>/dev/null

# 列出所有工具
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | ORACLE_USER=test ORACLE_PASSWORD=test ORACLE_CONNECT_STRING=localhost:1521/ORCLPDB1 \
  node dist/index.js 2>/dev/null | python -m json.tool
```

---

## 测试速查表

| 方式 | 需要 Oracle? | 命令 | 用途 |
|------|-------------|------|------|
| 单元测试 | ❌ | `npm test` | 安全函数边界测试 |
| 离线协议测试 | ❌ | `npm run test:offline` | MCP 协议 + 安全防线 |
| MCP Inspector | ❌ | `npm run inspector` | 可视化调试工具 |
| 端到端测试 | ✅ | `npm run test:e2e` | 真实数据库全流程 |
| WorkBuddy 集成 | ✅ | 配置 mcp.json | 实际对话中使用 |
