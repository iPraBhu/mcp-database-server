import { describe, it, expect } from 'vitest';
import {
  redactUrl,
  interpolateEnv,
  extractTableNames,
  findJoinPaths,
  formatCsvValue,
  isWriteOperation,
  limitRows,
  pushDownResultLimit,
  serializeCsvRow,
  trimRowsBySerializedSize,
} from '../src/utils.js';

describe('Utils', () => {
  describe('redactUrl', () => {
    it('should redact password in PostgreSQL URL', () => {
      const url = 'postgresql://user:secret123@localhost:5432/dbname';
      const redacted = redactUrl(url);
      expect(redacted).not.toContain('secret123');
      expect(redacted).toContain('***');
    });

    it('should redact password in SQL Server connection string', () => {
      const url = 'Server=localhost;Database=test;User Id=sa;Password=MySecret123';
      const redacted = redactUrl(url);
      expect(redacted).not.toContain('MySecret123');
      expect(redacted).toContain('Password=***');
    });

    it('should redact password in Oracle connection string', () => {
      const url = 'user/password@localhost:1521/XEPDB1';
      const redacted = redactUrl(url);
      expect(redacted).not.toContain('password');
      expect(redacted).toContain('/***@');
    });
  });

  describe('interpolateEnv', () => {
    it('should interpolate environment variables', () => {
      process.env.TEST_VAR = 'test-value';
      const result = interpolateEnv('postgresql://user:${TEST_VAR}@localhost');
      expect(result).toBe('postgresql://user:test-value@localhost');
    });

    it('should handle multiple variables', () => {
      process.env.HOST = 'localhost';
      process.env.PORT = '5432';
      const result = interpolateEnv('postgresql://user@${HOST}:${PORT}/db');
      expect(result).toBe('postgresql://user@localhost:5432/db');
    });
  });

  describe('extractTableNames', () => {
    it('should extract table names from SELECT', () => {
      const sql = 'SELECT * FROM users JOIN orders ON users.id = orders.user_id';
      const tables = extractTableNames(sql);
      expect(tables).toContain('users');
      expect(tables).toContain('orders');
    });

    it('should extract table name from INSERT', () => {
      const sql = 'INSERT INTO products (name, price) VALUES (?, ?)';
      const tables = extractTableNames(sql);
      expect(tables).toContain('products');
    });

    it('should extract table name from UPDATE', () => {
      const sql = 'UPDATE users SET name = ? WHERE id = ?';
      const tables = extractTableNames(sql);
      expect(tables).toContain('users');
    });

    it('should handle schema-qualified names', () => {
      const sql = 'SELECT * FROM public.users';
      const tables = extractTableNames(sql);
      expect(tables).toContain('public.users');
    });
  });

  describe('isWriteOperation', () => {
    it('should detect INSERT', () => {
      expect(isWriteOperation('INSERT INTO users VALUES (1, "test")')).toBe(true);
    });

    it('should detect UPDATE', () => {
      expect(isWriteOperation('UPDATE users SET name = "test"')).toBe(true);
    });

    it('should detect DELETE', () => {
      expect(isWriteOperation('DELETE FROM users WHERE id = 1')).toBe(true);
    });

    it('should detect CREATE', () => {
      expect(isWriteOperation('CREATE TABLE users (id INT)')).toBe(true);
    });

    it('should not detect SELECT as write', () => {
      expect(isWriteOperation('SELECT * FROM users')).toBe(false);
    });

    it('should handle whitespace', () => {
      expect(isWriteOperation('  UPDATE users SET name = "test"')).toBe(true);
    });
  });

  describe('findJoinPaths', () => {
    it('should resolve unqualified table names across multiple joins', () => {
      const paths = findJoinPaths(
        ['users', 'order_items', 'products'],
        [
          {
            fromSchema: 'public',
            fromTable: 'orders',
            fromColumns: ['user_id'],
            toSchema: 'public',
            toTable: 'users',
            toColumns: ['id'],
            type: 'foreign_key',
          },
          {
            fromSchema: 'public',
            fromTable: 'order_items',
            fromColumns: ['order_id'],
            toSchema: 'public',
            toTable: 'orders',
            toColumns: ['id'],
            type: 'foreign_key',
          },
          {
            fromSchema: 'public',
            fromTable: 'order_items',
            fromColumns: ['product_id'],
            toSchema: 'public',
            toTable: 'products',
            toColumns: ['id'],
            type: 'foreign_key',
          },
        ]
      );

      expect(paths).toHaveLength(1);
      expect(paths[0].tables).toContain('public.users');
      expect(paths[0].tables).toContain('public.order_items');
      expect(paths[0].tables).toContain('public.products');
      expect(paths[0].joins.length).toBeGreaterThanOrEqual(2);
      expect(paths[0].joins[0].joinCondition).toContain('=');
    });
  });

  describe('limitRows', () => {
    it('should trim returned rows without mutating SQL', () => {
      const result = limitRows(
        {
          rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
          columns: ['id'],
          rowCount: 3,
          executionTimeMs: 1,
        },
        2
      );

      expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(result.rowCount).toBe(2);
    });

    it('should apply offset before trimming', () => {
      const result = limitRows(
        {
          rows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
          columns: ['id'],
          rowCount: 4,
          executionTimeMs: 1,
        },
        2,
        1
      );

      expect(result.rows).toEqual([{ id: 2 }, { id: 3 }]);
      expect(result.rowCount).toBe(2);
    });
  });

  describe('pushDownResultLimit', () => {
    it('should add a top-level limit for MariaDB/MySQL queries', () => {
      const result = pushDownResultLimit('SELECT * FROM users', 10, 'mysql');

      expect(result.applied).toBe(true);
      expect(result.sql).toContain('LIMIT 10');
    });

    it('should add a top-level limit for CTE queries', () => {
      const result = pushDownResultLimit(
        'WITH active_users AS (SELECT * FROM users) SELECT * FROM active_users',
        5,
        'mysql'
      );

      expect(result.applied).toBe(true);
      expect(result.sql).toContain('LIMIT 5');
    });

    it('should tighten an existing larger limit', () => {
      const result = pushDownResultLimit('SELECT * FROM users LIMIT 100', 10, 'mysql');

      expect(result.applied).toBe(true);
      expect(result.sql).toContain('LIMIT 10');
    });

    it('should keep a smaller existing limit unchanged', () => {
      const result = pushDownResultLimit('SELECT * FROM users LIMIT 5', 10, 'mysql');

      expect(result.applied).toBe(false);
      expect(result.sql).toBe('SELECT * FROM users LIMIT 5');
    });

    it('should preserve offsets when tightening a limit', () => {
      const result = pushDownResultLimit('SELECT * FROM users LIMIT 50 OFFSET 20', 10, 'mysql');

      expect(result.applied).toBe(true);
      expect(result.sql).toContain('LIMIT 10 OFFSET 20');
    });

    it('should add a paginated window when offset is requested', () => {
      const result = pushDownResultLimit('SELECT * FROM users', 10, 'mysql', 30);

      expect(result.applied).toBe(true);
      expect(result.sql).toContain('LIMIT 10 OFFSET 30');
    });

    it('should skip pushdown offset when the SQL already has a limit clause', () => {
      const result = pushDownResultLimit('SELECT * FROM users LIMIT 100', 10, 'mysql', 30);

      expect(result).toEqual({
        sql: 'SELECT * FROM users LIMIT 100',
        applied: false,
      });
    });

    it('should skip writes and unsupported dialects', () => {
      expect(pushDownResultLimit('UPDATE users SET name = ?', 10, 'mysql')).toEqual({
        sql: 'UPDATE users SET name = ?',
        applied: false,
      });

      expect(pushDownResultLimit('SELECT * FROM users', 10, 'mssql')).toEqual({
        sql: 'SELECT * FROM users',
        applied: false,
      });
    });
  });

  describe('trimRowsBySerializedSize', () => {
    it('should leave rows untouched when under the size cap', () => {
      const result = trimRowsBySerializedSize(
        {
          rows: [{ id: 1 }, { id: 2 }],
          columns: ['id'],
          rowCount: 2,
          executionTimeMs: 1,
        },
        1024
      );

      expect(result.truncated).toBe(false);
      expect(result.result.rows).toHaveLength(2);
    });

    it('should trim rows to fit the serialized size cap', () => {
      const result = trimRowsBySerializedSize(
        {
          rows: [
            { id: 1, note: 'x'.repeat(30) },
            { id: 2, note: 'y'.repeat(30) },
            { id: 3, note: 'z'.repeat(30) },
          ],
          columns: ['id', 'note'],
          rowCount: 3,
          executionTimeMs: 1,
        },
        120
      );

      expect(result.truncated).toBe(true);
      expect(result.result.rows).toHaveLength(2);
      expect(result.omittedRowCount).toBe(1);
      expect(result.sizeBytes).toBeLessThanOrEqual(120);
    });

    it('should allow an empty row set when the cap is extremely small', () => {
      const result = trimRowsBySerializedSize(
        {
          rows: [{ id: 1, note: 'x'.repeat(100) }],
          columns: ['id', 'note'],
          rowCount: 1,
          executionTimeMs: 1,
        },
        2
      );

      expect(result.truncated).toBe(true);
      expect(result.result.rows).toEqual([]);
      expect(result.sizeBytes).toBeLessThanOrEqual(2);
    });
  });

  describe('CSV serialization', () => {
    it('should escape CSV values correctly', () => {
      expect(formatCsvValue('hello,world')).toBe('"hello,world"');
      expect(formatCsvValue('say "hi"')).toBe('"say ""hi"""');
      expect(formatCsvValue(null)).toBe('');
    });

    it('should serialize a row using the requested column order', () => {
      const result = serializeCsvRow(
        {
          id: 1,
          name: 'Alice',
          meta: { active: true },
        },
        ['name', 'id', 'meta']
      );

      expect(result).toBe('Alice,1,"{""active"":true}"');
    });
  });
});
