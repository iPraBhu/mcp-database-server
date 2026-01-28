import fs from 'fs/promises';
import path from 'path';
import { DatabaseSchema, Relationship, CacheError } from './types.js';
import { inferRelationships } from './utils.js';
import { getLogger } from './logger.js';

export interface CacheEntry {
  schema: DatabaseSchema;
  relationships: Relationship[];
  cachedAt: Date;
  ttlMinutes: number;
}

export interface CacheStatus {
  dbId: string;
  exists: boolean;
  age?: number; // milliseconds
  ttlMinutes?: number;
  expired?: boolean;
  version?: string;
  tableCount?: number;
  relationshipCount?: number;
}

export class SchemaCache {
  private logger = getLogger();
  private cache = new Map<string, CacheEntry>();
  private introspectionLocks = new Map<string, Promise<void>>();

  constructor(
    private _cacheDir: string,
    private _defaultTtlMinutes: number
  ) {}

  async init(): Promise<void> {
    try {
      this.logger.info({ cacheDir: this._cacheDir }, 'Initializing schema cache directory');
      await fs.mkdir(this._cacheDir, { recursive: true });
      this.logger.info({ cacheDir: this._cacheDir }, 'Schema cache initialized');
    } catch (error: any) {
      this.logger.error({ cacheDir: this._cacheDir, error: error.message }, 'Failed to initialize cache directory');
      throw new CacheError('Failed to initialize cache directory', error);
    }
  }

  /**
   * Get cached schema if valid, otherwise return null
   */
  async get(dbId: string): Promise<CacheEntry | null> {
    // Check memory cache first
    const memEntry = this.cache.get(dbId);
    if (memEntry && !this.isExpired(memEntry)) {
      return memEntry;
    }

    // Try to load from disk
    try {
      const diskEntry = await this.loadFromDisk(dbId);
      if (diskEntry && !this.isExpired(diskEntry)) {
        this.cache.set(dbId, diskEntry);
        return diskEntry;
      }
    } catch (error) {
      this.logger.warn({ dbId, error }, 'Failed to load cache from disk');
    }

    return null;
  }

  /**
   * Set or update cache entry
   */
  async set(dbId: string, schema: DatabaseSchema, ttlMinutes?: number): Promise<void> {
    const entry: CacheEntry = {
      schema,
      relationships: this.buildRelationships(schema),
      cachedAt: new Date(),
      ttlMinutes: ttlMinutes || this._defaultTtlMinutes,
    };

    this.cache.set(dbId, entry);

    // Persist to disk asynchronously
    this.saveToDisk(dbId, entry).catch((error) => {
      this.logger.error({ dbId, error }, 'Failed to save cache to disk');
    });
  }

  /**
   * Clear cache for a specific database or all databases
   */
  async clear(dbId?: string): Promise<void> {
    if (dbId) {
      this.cache.delete(dbId);
      try {
        const filePath = this.getCacheFilePath(dbId);
        await fs.unlink(filePath);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          this.logger.warn({ dbId, error }, 'Failed to delete cache file');
        }
      }
      this.logger.info({ dbId }, 'Cache cleared');
    } else {
      this.cache.clear();
      try {
        const files = await fs.readdir(this._cacheDir);
        await Promise.all(
          files
            .filter((f) => f.endsWith('.json'))
            .map((f) => fs.unlink(path.join(this._cacheDir, f)))
        );
      } catch (error) {
        this.logger.warn({ error }, 'Failed to clear cache directory');
      }
      this.logger.info('All caches cleared');
    }
  }

  /**
   * Get cache status
   */
  async getStatus(dbId?: string): Promise<CacheStatus[]> {
    const statuses: CacheStatus[] = [];

    if (dbId) {
      const status = await this.getStatusForDb(dbId);
      statuses.push(status);
    } else {
      // Get status for all cached databases
      const dbIds = new Set([
        ...this.cache.keys(),
        ...(await this.getPersistedDbIds()),
      ]);

      for (const id of dbIds) {
        const status = await this.getStatusForDb(id);
        statuses.push(status);
      }
    }

    return statuses;
  }

  private async getStatusForDb(dbId: string): Promise<CacheStatus> {
    const entry = await this.get(dbId);

    if (!entry) {
      return {
        dbId,
        exists: false,
      };
    }

    const age = Date.now() - new Date(entry.cachedAt).getTime();
    const expired = this.isExpired(entry);

    return {
      dbId,
      exists: true,
      age,
      ttlMinutes: entry.ttlMinutes,
      expired,
      version: entry.schema.version,
      tableCount: entry.schema.schemas.reduce((sum, s) => sum + s.tables.length, 0),
      relationshipCount: entry.relationships.length,
    };
  }

  /**
   * Acquire lock for introspection to prevent concurrent introspection
   */
  async acquireIntrospectionLock(dbId: string): Promise<() => void> {
    // Wait for existing introspection to complete
    const existingLock = this.introspectionLocks.get(dbId);
    if (existingLock) {
      await existingLock;
    }

    // Create new lock
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.introspectionLocks.set(dbId, lockPromise);

    return () => {
      releaseLock!();
      this.introspectionLocks.delete(dbId);
    };
  }

  private isExpired(entry: CacheEntry): boolean {
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    const ttlMs = entry.ttlMinutes * 60 * 1000;
    return age > ttlMs;
  }

  private buildRelationships(schema: DatabaseSchema): Relationship[] {
    const relationships: Relationship[] = [];

    // Collect explicit foreign key relationships
    for (const schemaObj of schema.schemas) {
      for (const table of schemaObj.tables) {
        for (const fk of table.foreignKeys) {
          relationships.push({
            fromSchema: schemaObj.name,
            fromTable: table.name,
            fromColumns: fk.columns,
            toSchema: fk.referencedSchema,
            toTable: fk.referencedTable,
            toColumns: fk.referencedColumns,
            type: 'foreign_key',
          });
        }
      }
    }

    // Infer additional relationships
    const inferred = inferRelationships(schema);
    
    // Avoid duplicates
    const relationshipKeys = new Set(
      relationships.map((r) => this.getRelationshipKey(r))
    );
    
    for (const rel of inferred) {
      const key = this.getRelationshipKey(rel);
      if (!relationshipKeys.has(key)) {
        relationships.push(rel);
        relationshipKeys.add(key);
      }
    }

    return relationships;
  }

  private getRelationshipKey(rel: Relationship): string {
    return `${rel.fromSchema}.${rel.fromTable}.${rel.fromColumns.join(',')}→${rel.toSchema}.${rel.toTable}.${rel.toColumns.join(',')}`;
  }

  private getCacheFilePath(dbId: string): string {
    return path.join(this._cacheDir, `${dbId}.json`);
  }

  private async loadFromDisk(dbId: string): Promise<CacheEntry | null> {
    try {
      const filePath = this.getCacheFilePath(dbId);
      const data = await fs.readFile(filePath, 'utf-8');
      const entry = JSON.parse(data);
      
      // Convert date strings back to Date objects
      entry.cachedAt = new Date(entry.cachedAt);
      entry.schema.introspectedAt = new Date(entry.schema.introspectedAt);
      
      return entry;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async saveToDisk(dbId: string, entry: CacheEntry): Promise<void> {
    const filePath = this.getCacheFilePath(dbId);
    const data = JSON.stringify(entry, null, 2);
    await fs.writeFile(filePath, data, 'utf-8');
  }

  private async getPersistedDbIds(): Promise<string[]> {
    try {
      const files = await fs.readdir(this._cacheDir);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
    } catch {
      return [];
    }
  }
}
