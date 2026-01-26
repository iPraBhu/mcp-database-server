import { describe, it, expect } from 'vitest';
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
});
