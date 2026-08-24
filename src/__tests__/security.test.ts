/**
 * Unit tests for security functions
 *
 * These tests verify the security boundary of the MCP server:
 * - isReadOnlyQuery: blocks DML/DDL in read-only contexts
 * - applyRowLimit: enforces row caps
 * - parseTnsAliasesContent: correctly parses tnsnames.ora
 * - validateIdentifier: blocks SQL injection via identifier names
 * - isTableAllowed: whitelist/blacklist enforcement
 * - IDENTIFIER_REGEX: basic identifier validation
 * - assertSafeBindValues: big-number (> 2^53) bind precision guard
 * - buildRowidSelectSql: ROWID-based row fetch SQL
 */

import { describe, it, expect } from "vitest";
import {
  IDENTIFIER_REGEX,
  isReadOnlyQuery,
  applyRowLimit,
  parseTnsAliasesContent,
  validateIdentifier,
  isTableAllowed,
  BIND_MAX_SAFE_INTEGER,
  assertSafeBindValues,
  buildRowidSelectSql,
} from "../security.js";

// ================================================================
// isReadOnlyQuery
// ================================================================
describe("isReadOnlyQuery", () => {
  it("accepts SELECT queries", () => {
    expect(isReadOnlyQuery("SELECT * FROM users")).toBe(true);
    expect(isReadOnlyQuery("select id, name from employees")).toBe(true);
    expect(isReadOnlyQuery("  SELECT 1 FROM dual  ")).toBe(true);
  });

  it("accepts WITH (CTE) queries", () => {
    expect(isReadOnlyQuery("WITH cte AS (SELECT * FROM users) SELECT * FROM cte")).toBe(true);
  });

  it("accepts SELECT with trailing semicolon", () => {
    expect(isReadOnlyQuery("SELECT * FROM users;")).toBe(true);
    expect(isReadOnlyQuery("SELECT * FROM users ;")).toBe(true);
  });

  it("rejects INSERT", () => {
    expect(isReadOnlyQuery("INSERT INTO users VALUES (1, 'a')")).toBe(false);
  });

  it("rejects UPDATE", () => {
    expect(isReadOnlyQuery("UPDATE users SET name = 'a' WHERE id = 1")).toBe(false);
  });

  it("rejects DELETE", () => {
    expect(isReadOnlyQuery("DELETE FROM users WHERE id = 1")).toBe(false);
  });

  it("rejects DROP", () => {
    expect(isReadOnlyQuery("DROP TABLE users")).toBe(false);
  });

  it("rejects TRUNCATE", () => {
    expect(isReadOnlyQuery("TRUNCATE TABLE users")).toBe(false);
  });

  it("rejects ALTER", () => {
    expect(isReadOnlyQuery("ALTER TABLE users ADD COLUMN x VARCHAR2(10)")).toBe(false);
  });

  it("rejects CREATE", () => {
    expect(isReadOnlyQuery("CREATE TABLE test (id NUMBER)")).toBe(false);
  });

  it("rejects MERGE", () => {
    expect(isReadOnlyQuery("MERGE INTO users USING dual ON (1=1) WHEN MATCHED THEN UPDATE SET x = 1")).toBe(false);
  });

  it("rejects GRANT", () => {
    expect(isReadOnlyQuery("GRANT SELECT ON users TO scott")).toBe(false);
  });

  it("rejects CALL", () => {
    expect(isReadOnlyQuery("CALL my_procedure()")).toBe(false);
  });

  it("rejects EXEC", () => {
    expect(isReadOnlyQuery("EXEC my_procedure")).toBe(false);
  });

  // SQL Injection attempts
  it("rejects multi-statement injection (semicolon + more SQL)", () => {
    expect(isReadOnlyQuery("SELECT * FROM users; DROP TABLE users")).toBe(false);
    expect(isReadOnlyQuery("SELECT 1; DELETE FROM users")).toBe(false);
    expect(isReadOnlyQuery("SELECT 1;-- DROP TABLE users")).toBe(false);
  });

  it("rejects DML keywords hidden inside SELECT (word boundary check)", () => {
    expect(isReadOnlyQuery("SELECT * FROM users WHERE name = 'DELETE'")).toBe(false);
    expect(isReadOnlyQuery("SELECT * FROM users WHERE name = 'UPDATE'")).toBe(false);
  });

  it("does not false-positive on column names like 'updated_at'", () => {
    // 'UPDATE' inside 'updated_at' should NOT trigger the word boundary check
    // because we're checking the UPPERCASE version
    expect(isReadOnlyQuery("SELECT updated_at FROM logs")).toBe(true);
    expect(isReadOnlyQuery("SELECT last_updated FROM logs")).toBe(true);
  });
});

// ================================================================
// applyRowLimit
// ================================================================
describe("applyRowLimit", () => {
  it("adds FETCH FIRST when no limit present", () => {
    const result = applyRowLimit("SELECT * FROM users", 100);
    expect(result).toContain("FETCH FIRST 101 ROWS ONLY");
    expect(result).toBe("SELECT * FROM users FETCH FIRST 101 ROWS ONLY");
  });

  it("preserves existing FETCH FIRST", () => {
    const sql = "SELECT * FROM users FETCH FIRST 50 ROWS ONLY";
    expect(applyRowLimit(sql, 100)).toBe(sql);
  });

  it("preserves existing FETCH NEXT", () => {
    const sql = "SELECT * FROM users FETCH NEXT 50 ROWS ONLY";
    expect(applyRowLimit(sql, 100)).toBe(sql);
  });

  it("preserves existing ROWNUM limit", () => {
    const sql = "SELECT * FROM users WHERE ROWNUM <= 10";
    expect(applyRowLimit(sql, 100)).toBe(sql);
  });

  it("strips trailing semicolon before adding limit", () => {
    const result = applyRowLimit("SELECT * FROM users;", 100);
    expect(result).not.toContain(";");
    expect(result).toContain("FETCH FIRST 101 ROWS ONLY");
  });

  it("adds maxRows + 1 to allow truncation detection", () => {
    const result = applyRowLimit("SELECT * FROM users", 50);
    expect(result).toContain("FETCH FIRST 51 ROWS ONLY");
  });
});

// ================================================================
// parseTnsAliasesContent
// ================================================================
describe("parseTnsAliasesContent", () => {
  const sampleTns = `# tnsnames.ora Network Configuration File
# Generated by Oracle configuration tools.

ORCLPDB1 =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCLPDB1)
    )
  )

ORCL =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCL)
    )
  )

# Comment line
PROD_DB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = prod.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = PROD)
    )
  )
`;

  it("extracts all top-level aliases", () => {
    const aliases = parseTnsAliasesContent(sampleTns);
    expect(aliases).toContain("ORCLPDB1");
    expect(aliases).toContain("ORCL");
    expect(aliases).toContain("PROD_DB");
    expect(aliases).toHaveLength(3);
  });

  it("filters out inner keywords like DESCRIPTION, ADDRESS", () => {
    const aliases = parseTnsAliasesContent(sampleTns);
    expect(aliases).not.toContain("DESCRIPTION");
    expect(aliases).not.toContain("ADDRESS");
    expect(aliases).not.toContain("CONNECT_DATA");
    expect(aliases).not.toContain("PROTOCOL");
    expect(aliases).not.toContain("SERVER");
    expect(aliases).not.toContain("SERVICE_NAME");
  });

  it("handles comment-only lines", () => {
    const content = `# This is a comment
# Another comment
MYDB = (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=x)(PORT=1))(CONNECT_DATA=(SERVICE_NAME=x)))`;
    const aliases = parseTnsAliasesContent(content);
    expect(aliases).toEqual(["MYDB"]);
  });

  it("returns empty array for empty content", () => {
    expect(parseTnsAliasesContent("")).toEqual([]);
    expect(parseTnsAliasesContent("# just comments\n# more comments")).toEqual([]);
  });

  it("deduplicates aliases with same name", () => {
    const content = `MYDB = (DESCRIPTION=...)
MYDB = (DESCRIPTION=...)`;
    const aliases = parseTnsAliasesContent(content);
    expect(aliases).toEqual(["MYDB"]);
  });

  it("handles aliases with unusual formatting", () => {
    const content = `MY_DB    =
  (DESCRIPTION=...)`;
    const aliases = parseTnsAliasesContent(content);
    expect(aliases).toEqual(["MY_DB"]);
  });
});

// ================================================================
// validateIdentifier
// ================================================================
describe("validateIdentifier", () => {
  it("accepts valid identifiers", () => {
    expect(() => validateIdentifier("users")).not.toThrow();
    expect(() => validateIdentifier("order_items")).not.toThrow();
    expect(() => validateIdentifier("_private")).not.toThrow();
    expect(() => validateIdentifier("TABLE_123")).not.toThrow();
    expect(() => validateIdentifier("a")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateIdentifier("")).toThrow();
  });

  it("rejects identifiers starting with a digit", () => {
    expect(() => validateIdentifier("1table")).toThrow();
    expect(() => validateIdentifier("9users")).toThrow();
  });

  it("rejects identifiers with special characters", () => {
    expect(() => validateIdentifier("user-name")).toThrow();
    expect(() => validateIdentifier("user.name")).toThrow();
    expect(() => validateIdentifier("user name")).toThrow();
    expect(() => validateIdentifier("user;DROP")).toThrow();
    expect(() => validateIdentifier("user'name")).toThrow();
    expect(() => validateIdentifier("user`name")).toThrow();
  });

  it("rejects SQL injection attempts in identifiers", () => {
    expect(() => validateIdentifier("users; DROP TABLE users")).toThrow();
    expect(() => validateIdentifier("users--")).toThrow();
    expect(() => validateIdentifier("users/*")).toThrow();
    expect(() => validateIdentifier("users OR 1=1")).toThrow();
  });

  it("rejects identifiers exceeding 128 characters", () => {
    const longName = "a".repeat(129);
    expect(() => validateIdentifier(longName)).toThrow();
    const maxName = "a".repeat(128);
    expect(() => validateIdentifier(maxName)).not.toThrow();
  });
});

// ================================================================
// IDENTIFIER_REGEX
// ================================================================
describe("IDENTIFIER_REGEX", () => {
  it("matches valid identifiers", () => {
    expect(IDENTIFIER_REGEX.test("users")).toBe(true);
    expect(IDENTIFIER_REGEX.test("_hidden")).toBe(true);
    expect(IDENTIFIER_REGEX.test("TABLE_NAME_1")).toBe(true);
  });

  it("does not match invalid identifiers", () => {
    expect(IDENTIFIER_REGEX.test("1table")).toBe(false);
    expect(IDENTIFIER_REGEX.test("user-name")).toBe(false);
    expect(IDENTIFIER_REGEX.test("")).toBe(false);
    expect(IDENTIFIER_REGEX.test("user name")).toBe(false);
    expect(IDENTIFIER_REGEX.test("user;")).toBe(false);
  });
});

// ================================================================
// isTableAllowed
// ================================================================
describe("isTableAllowed", () => {
  it("allows all tables when no whitelist or blacklist", () => {
    expect(isTableAllowed("users", [], [])).toEqual({ allowed: true });
    expect(isTableAllowed("orders", [], [])).toEqual({ allowed: true });
  });

  it("blocks tables in the blacklist", () => {
    expect(isTableAllowed("secret_config", [], ["SECRET_CONFIG"])).toEqual({
      allowed: false,
      reason: "table is in the BLOCKED_TABLES list",
    });
  });

  it("only allows whitelisted tables when whitelist is non-empty", () => {
    expect(isTableAllowed("users", ["USERS", "ORDERS"], [])).toEqual({ allowed: true });
    expect(isTableAllowed("secret", ["USERS", "ORDERS"], [])).toEqual({
      allowed: false,
      reason: "table is not in the ALLOWED_TABLES whitelist",
    });
  });

  it("blacklist takes priority over whitelist", () => {
    // Table is in both whitelist and blacklist → blocked
    expect(isTableAllowed("users", ["USERS"], ["USERS"])).toEqual({
      allowed: false,
      reason: "table is in the BLOCKED_TABLES list",
    });
  });

  it("case-insensitive comparison", () => {
    expect(isTableAllowed("Users", ["USERS"], [])).toEqual({ allowed: true });
    expect(isTableAllowed("USERS", ["users"], [])).toEqual({ allowed: true });
    expect(isTableAllowed("Orders", [], ["ORDERS"])).toEqual({
      allowed: false,
      reason: "table is in the BLOCKED_TABLES list",
    });
  });
});
// ================================================================
// assertSafeBindValues — big-number (> 2^53) bind precision guard
// ================================================================
describe("assertSafeBindValues", () => {
  it("does not throw for safe primitive binds", () => {
    expect(() => assertSafeBindValues([1, 2, 3], "p")).not.toThrow();
    expect(() => assertSafeBindValues(["9007199254740993", 42, true, null], "p")).not.toThrow();
    expect(() => assertSafeBindValues([1.5, -0.25, 0], "p")).not.toThrow();
    expect(() => assertSafeBindValues({ a: 1, b: "x" }, "p")).not.toThrow();
    expect(() => assertSafeBindValues([], "p")).not.toThrow();
    expect(() => assertSafeBindValues(null, "p")).not.toThrow();
    expect(() => assertSafeBindValues(undefined, "p")).not.toThrow();
  });

  it("accepts the exact safe integer boundary (2^53 - 1)", () => {
    expect(() => assertSafeBindValues([BIND_MAX_SAFE_INTEGER], "p")).not.toThrow();
    expect(() => assertSafeBindValues([-BIND_MAX_SAFE_INTEGER], "p")).not.toThrow();
    expect(BIND_MAX_SAFE_INTEGER).toBe(9007199254740991);
  });

  it("rejects integers beyond 2^53 - 1 (silent precision loss)", () => {
    const unsafe = BIND_MAX_SAFE_INTEGER + 1; // 9007199254740992 — already rounded by JS
    expect(() => assertSafeBindValues([unsafe], "db_query params")).toThrow(/Unsafe numeric bind value/);
    expect(() => assertSafeBindValues([1, unsafe], "db_query params")).toThrow(/\[1\]/);
    expect(() => assertSafeBindValues([-unsafe], "db_query params")).toThrow(/Unsafe numeric bind value/);
  });

  it("rejects unsafe integers inside named-bind records with the key name", () => {
    expect(() =>
      assertSafeBindValues({ w_1: BIND_MAX_SAFE_INTEGER + 1 }, "db_delete where_params")
    ).toThrow(/"/);
    expect(() =>
      assertSafeBindValues({ s_id: 7, w_1: BIND_MAX_SAFE_INTEGER + 1 }, "db_update data + where_params")
    ).toThrow(/w_1/);
  });

  it("rejects NaN and infinities", () => {
    expect(() => assertSafeBindValues([NaN], "p")).toThrow(/not a finite number/);
    expect(() => assertSafeBindValues([Infinity], "p")).toThrow(/not a finite number/);
    expect(() => assertSafeBindValues([-Infinity], "p")).toThrow(/not a finite number/);
    expect(() => assertSafeBindValues({ a: Infinity }, "p")).toThrow(/not a finite number/);
  });

  it("accepts big integers passed as strings (the documented workaround)", () => {
    expect(() => assertSafeBindValues(["9007199254740993"], "p")).not.toThrow();
    expect(() => assertSafeBindValues({ id: "9007199254740993" }, "p")).not.toThrow();
  });

  it("accepts oracledb bind-definition objects with safe values", () => {
    expect(() => assertSafeBindValues([{ val: 42, type: 2016 }], "p")).not.toThrow();
    expect(() => assertSafeBindValues({ id: { val: "9007199254740993", type: 2016 } }, "p")).not.toThrow();
  });

  it("inspects the inner val of oracledb bind-definition objects", () => {
    expect(() => assertSafeBindValues([{ val: BIND_MAX_SAFE_INTEGER + 1, type: 2016 }], "p")).toThrow(/Unsafe numeric bind value/);
  });

  it("reports every offender, not just the first", () => {
    expect(() =>
      assertSafeBindValues([1, BIND_MAX_SAFE_INTEGER + 1, 2, BIND_MAX_SAFE_INTEGER + 2], "p")
    ).toThrow(/\[1\].*\[3\]/s);
  });

  it("throws a ValidationError with a string-passing hint", () => {
    try {
      assertSafeBindValues([BIND_MAX_SAFE_INTEGER + 1], "p");
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as { code?: string; hint?: string; message: string };
      expect(e.code).toBe("BIND_PRECISION_ERROR");
      expect(e.hint).toContain("Pass big integers as strings");
      expect(e.message).toContain("9007199254740992");
    }
  });
});

// ================================================================
// buildRowidSelectSql — ROWID-based row fetch SQL
// ================================================================
describe("buildRowidSelectSql", () => {
  it("builds a ROWID select for a valid table name", () => {
    expect(buildRowidSelectSql("users")).toBe("SELECT * FROM USERS WHERE ROWID = :rowid_val");
  });

  it("uppercases the table name like other SQL builders", () => {
    expect(buildRowidSelectSql("order_items")).toBe("SELECT * FROM ORDER_ITEMS WHERE ROWID = :rowid_val");
    expect(buildRowidSelectSql("USERS")).toBe("SELECT * FROM USERS WHERE ROWID = :rowid_val");
  });

  it("rejects invalid table names (identifier validation)", () => {
    expect(() => buildRowidSelectSql("1table")).toThrow();
    expect(() => buildRowidSelectSql("users; DROP TABLE users")).toThrow();
    expect(() => buildRowidSelectSql("user name")).toThrow();
  });
});

