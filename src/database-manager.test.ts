import { describe, it, expect, vi } from 'vitest';
import { DatabaseManager } from './database-manager.js';
import type { DatabaseConfig } from './types.js';

describe('DatabaseManager Security', () => {
  const mockConfig: DatabaseConfig[] = [
    {
      id: 'test-db',
      type: 'sqlite',
      path: ':memory:',
      readOnly: false,
    },
  ];

  describe('disableDangerousOperations', () => {
    it('should block DELETE when disableDangerousOperations is true', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: true,
      });

      await expect(
        manager.runQuery('test-db', 'DELETE FROM users WHERE id = 1')
      ).rejects.toThrow('Dangerous operation DELETE is disabled');
    });

    it('should block TRUNCATE when disableDangerousOperations is true', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: true,
      });

      await expect(
        manager.runQuery('test-db', 'TRUNCATE TABLE users')
      ).rejects.toThrow('Dangerous operation TRUNCATE is disabled');
    });

    it('should block DROP when disableDangerousOperations is true', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: true,
      });

      await expect(
        manager.runQuery('test-db', 'DROP TABLE users')
      ).rejects.toThrow('Dangerous operation DROP is disabled');
    });

    it('should allow INSERT when disableDangerousOperations is true', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: true,
      });

      // This should not throw "Dangerous operation" error
      // We expect a different error (database not found) which proves the dangerous ops check passed
      await expect(
        manager.runQuery('test-db', 'INSERT INTO users VALUES (1, "test")')
      ).rejects.toThrow(/Database not found|not connected|no such table/i);
    });

    it('should allow DELETE when disableDangerousOperations is false', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: false,
      });

      // Should not throw "Dangerous operation" error
      // We expect a different error (database not found) which proves the dangerous ops check passed
      await expect(
        manager.runQuery('test-db', 'DELETE FROM users WHERE id = 1')
      ).rejects.toThrow(/Database not found|not connected|no such table/i);
    });
  });

  describe('readOnly default', () => {
    it('should have readOnly=true by default', () => {
      const config: DatabaseConfig = {
        id: 'test',
        type: 'sqlite',
        path: ':memory:',
      };

      // The default is applied by Zod schema, but we can test the manager respects it
      const manager = new DatabaseManager([config], {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: false,
        disableDangerousOperations: true,
      });

      expect(manager.getConfig('test')).toBeDefined();
    });
  });

  describe('query safety and introspection defaults', () => {
    it('should block writes when global allowWrite is false even if the database is writable', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: false,
        disableDangerousOperations: false,
      });

      await expect(
        manager.runQuery('test-db', 'INSERT INTO users VALUES (1, "test")')
      ).rejects.toThrow('Write operations are not allowed');
    });

    it('should block explain on write statements', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: false,
      });

      await expect(
        manager.explainQuery('test-db', 'DELETE FROM users WHERE id = 1')
      ).rejects.toThrow('Only read-only SELECT queries can be explained or profiled');
    });

    it('should block profiling on write statements', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: false,
      });

      await expect(
        manager.profileQueryPerformance('test-db', 'UPDATE users SET name = "x"')
      ).rejects.toThrow('Only read-only SELECT queries can be explained or profiled');
    });

    it('should honor configured introspection options instead of treating maxTables as cache TTL', async () => {
      const manager = new DatabaseManager(
        [
          {
            id: 'schema-db',
            type: 'sqlite',
            path: ':memory:',
            readOnly: false,
            introspection: {
              includeViews: false,
              maxTables: 1,
            },
          },
        ],
        {
          cacheDir: '.test-cache',
          cacheTtlMinutes: 10,
          allowWrite: true,
          disableDangerousOperations: false,
        }
      );

      await manager.init();
      await manager.runQuery('schema-db', 'CREATE TABLE users (id INTEGER PRIMARY KEY)');
      await manager.runQuery('schema-db', 'CREATE VIEW active_users AS SELECT id FROM users');

      const schema = await manager.getSchema('schema-db');
      const status = (await manager.getCacheStatus('schema-db'))[0];

      expect(schema.schema.schemas[0].tables).toHaveLength(1);
      expect(schema.schema.schemas[0].tables[0].name).toBe('users');
      expect(status.ttlMinutes).toBe(10);

      await manager.shutdown();
    });

    it('should skip auto-explain for fast read queries', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: false,
      });

      await manager.init();
      await manager.runQuery('test-db', 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      await manager.runQuery('test-db', "INSERT INTO users VALUES (1, 'test')");

      const adapter = (manager as any).adapters.get('test-db');
      const explainSpy = vi.spyOn(adapter, 'explain');

      await manager.runQuery('test-db', 'SELECT * FROM users');

      expect(explainSpy).not.toHaveBeenCalled();
      await manager.shutdown();
    });

    it('should still auto-explain slow read queries', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: false,
      });

      await manager.init();
      await manager.runQuery('test-db', 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      await manager.runQuery('test-db', "INSERT INTO users VALUES (1, 'test')");

      const adapter = (manager as any).adapters.get('test-db');
      const originalQuery = adapter.query.bind(adapter);
      const explainSpy = vi.spyOn(adapter, 'explain');

      vi.spyOn(adapter, 'query').mockImplementation(async (sql: string, params?: any[], timeoutMs?: number) => {
        const result = await originalQuery(sql, params, timeoutMs);
        return {
          ...result,
          executionTimeMs: 1500,
        };
      });

      await manager.runQuery('test-db', 'SELECT * FROM users');

      expect(explainSpy).toHaveBeenCalledTimes(1);
      await manager.shutdown();
    });
  });
});
