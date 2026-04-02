import { describe, it, expect } from 'vitest';
import {
  redactUrl,
  interpolateEnv,
  extractTableNames,
  findJoinPaths,
  isWriteOperation,
  limitRows,
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
  });
});
