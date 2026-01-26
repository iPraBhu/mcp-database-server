import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { SchemaCache } from '../src/cache.js';
import { DatabaseSchema } from '../src/types.js';

describe('SchemaCache', () => {
  const testCacheDir = '.test-cache';
  let cache: SchemaCache;

  beforeEach(async () => {
    cache = new SchemaCache(testCacheDir, 10);
    await cache.init();
  });

  afterEach(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true });
  });

  it('should initialize cache directory', async () => {
    const stats = await fs.stat(testCacheDir);
    expect(stats.isDirectory()).toBe(true);
  });

  it('should cache and retrieve schema', async () => {
    const schema: DatabaseSchema = {
      dbId: 'test-db',
      dbType: 'postgres',
      schemas: [
        {
          name: 'public',
          tables: [
            {
              schema: 'public',
              name: 'users',
              type: 'table',
              columns: [
                {
                  name: 'id',
                  dataType: 'integer',
                  nullable: false,
                },
              ],
              indexes: [],
              foreignKeys: [],
            },
          ],
        },
      ],
      introspectedAt: new Date(),
      version: 'test-version',
    };

    await cache.set('test-db', schema);
    const entry = await cache.get('test-db');

    expect(entry).not.toBeNull();
    expect(entry!.schema.dbId).toBe('test-db');
    expect(entry!.schema.schemas[0].tables[0].name).toBe('users');
  });

  it('should return null for expired cache', async () => {
    const schema: DatabaseSchema = {
      dbId: 'test-db',
      dbType: 'postgres',
      schemas: [],
      introspectedAt: new Date(),
      version: 'test-version',
    };

    // Set with 0.001 TTL (1/1000th of a minute = 60ms)
    await cache.set('test-db', schema, 0.001);

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 100));

    const entry = await cache.get('test-db');
    expect(entry).toBeNull();
  });

  it('should clear specific database cache', async () => {
    const schema: DatabaseSchema = {
      dbId: 'test-db',
      dbType: 'postgres',
      schemas: [],
      introspectedAt: new Date(),
      version: 'test-version',
    };

    await cache.set('test-db', schema);
    await cache.clear('test-db');

    const entry = await cache.get('test-db');
    expect(entry).toBeNull();
  });

  it('should build relationships from foreign keys', async () => {
    const schema: DatabaseSchema = {
      dbId: 'test-db',
      dbType: 'postgres',
      schemas: [
        {
          name: 'public',
          tables: [
            {
              schema: 'public',
              name: 'orders',
              type: 'table',
              columns: [],
              indexes: [],
              foreignKeys: [
                {
                  name: 'fk_user',
                  columns: ['user_id'],
                  referencedSchema: 'public',
                  referencedTable: 'users',
                  referencedColumns: ['id'],
                },
              ],
            },
          ],
        },
      ],
      introspectedAt: new Date(),
      version: 'test-version',
    };

    await cache.set('test-db', schema);
    const entry = await cache.get('test-db');

    expect(entry!.relationships.length).toBeGreaterThan(0);
    expect(entry!.relationships[0].type).toBe('foreign_key');
    expect(entry!.relationships[0].fromTable).toBe('orders');
    expect(entry!.relationships[0].toTable).toBe('users');
  });
});
