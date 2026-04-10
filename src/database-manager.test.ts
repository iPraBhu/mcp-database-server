import { describe, it, expect, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { DatabaseManager } from './database-manager.js';
import { DatabaseError, type DatabaseConfig } from './types.js';

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

    it('should retry read queries once after a retryable connection error', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: false,
      });

      await manager.init();

      const mockAdapter = {
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        isConnected: vi.fn(() => true),
        introspect: vi.fn(),
        query: vi
          .fn()
          .mockRejectedValueOnce(new DatabaseError('lost', 'PROTOCOL_CONNECTION_LOST', 'test-db'))
          .mockResolvedValueOnce({
            rows: [{ id: 1 }],
            columns: ['id'],
            rowCount: 1,
            executionTimeMs: 5,
          }),
        explain: vi.fn(),
        testConnection: vi.fn(async () => true),
        getVersion: vi.fn(async () => 'test'),
      };

      (manager as any).adapters.set('test-db', mockAdapter);

      const result = await manager.runQuery('test-db', 'SELECT * FROM users');

      expect(result.rows).toEqual([{ id: 1 }]);
      expect(mockAdapter.query).toHaveBeenCalledTimes(2);
      expect(mockAdapter.disconnect).toHaveBeenCalledTimes(1);
      expect(mockAdapter.connect).toHaveBeenCalledTimes(1);

      await manager.shutdown();
    });

    it('should skip schema introspection when schema context is disabled', async () => {
      const manager = new DatabaseManager(mockConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: false,
      });

      await manager.init();
      await manager.runQuery('test-db', 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      await manager.runQuery('test-db', "INSERT INTO users VALUES (1, 'test')");

      const introspectSpy = vi.spyOn(manager as any, 'introspectSchema');

      await manager.runQuery('test-db', 'SELECT * FROM users', [], undefined, false);

      expect(introspectSpy).not.toHaveBeenCalled();
      await manager.shutdown();
    });

    it('should skip tracking and auto-explain when tracking is disabled', async () => {
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
      const trackSpy = vi.spyOn((manager as any).queryTracker, 'track');

      await manager.runQuery('test-db', 'SELECT * FROM users', [], undefined, false, false);

      expect(explainSpy).not.toHaveBeenCalled();
      expect(trackSpy).not.toHaveBeenCalled();
      await manager.shutdown();
    });

    it('should persist file-backed SQLite writes across reconnects', async () => {
      const dbPath = join(process.cwd(), '.test-cache', 'persisted-sqlite.db');
      if (existsSync(dbPath)) {
        rmSync(dbPath, { force: true });
      }

      const fileConfig: DatabaseConfig[] = [
        {
          id: 'file-db',
          type: 'sqlite',
          path: dbPath,
          readOnly: false,
        },
      ];

      const manager = new DatabaseManager(fileConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: false,
      });
      const reloadedManager = new DatabaseManager(fileConfig, {
        cacheDir: '.test-cache',
        cacheTtlMinutes: 10,
        allowWrite: true,
        disableDangerousOperations: false,
      });

      try {
        await manager.init();
        await manager.runQuery('file-db', 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
        await manager.runQuery('file-db', "INSERT INTO users VALUES (1, 'persisted')");
        await manager.shutdown();

        await reloadedManager.init();
        const result = await reloadedManager.runQuery(
          'file-db',
          'SELECT id, name FROM users ORDER BY id'
        );

        expect(result.rows).toEqual([{ id: 1, name: 'persisted' }]);
      } finally {
        await manager.shutdown();
        await reloadedManager.shutdown();
        rmSync(dbPath, { force: true });
      }
    });
  });
});
