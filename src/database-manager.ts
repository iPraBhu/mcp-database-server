import { DatabaseAdapter, DatabaseConfig, IntrospectionOptions, QueryResult } from './types.js';
import { createAdapter } from './adapters/index.js';
import { SchemaCache, CacheEntry } from './cache.js';
import { QueryTracker } from './query-tracker.js';
import { isWriteOperation, findJoinPaths } from './utils.js';
import { getLogger } from './logger.js';

export interface DatabaseManagerOptions {
  cacheDir: string;
  cacheTtlMinutes: number;
  allowWrite: boolean;
  allowedWriteOperations?: string[];
}

export class DatabaseManager {
  private logger = getLogger();
  private adapters = new Map<string, DatabaseAdapter>();
  private cache: SchemaCache;
  private queryTracker = new QueryTracker();

  constructor(
    private configs: DatabaseConfig[],
    private options: DatabaseManagerOptions
  ) {
    this.cache = new SchemaCache(options.cacheDir, options.cacheTtlMinutes);
  }

  async init(): Promise<void> {
    await this.cache.init();

    // Create adapters
    for (const config of this.configs) {
      const adapter = createAdapter(config);
      this.adapters.set(config.id, adapter);

      // Connect eagerly if configured
      if (config.eagerConnect) {
        try {
          await this.connect(config.id);
        } catch (error) {
          this.logger.error({ dbId: config.id, error }, 'Failed to eager connect');
        }
      }
    }

    this.logger.info({ databases: this.configs.length }, 'Database manager initialized');
  }

  async shutdown(): Promise<void> {
    for (const [dbId, adapter] of this.adapters) {
      try {
        await adapter.disconnect();
      } catch (error) {
        this.logger.error({ dbId, error }, 'Failed to disconnect');
      }
    }
    this.logger.info('Database manager shut down');
  }

  getConfigs(): DatabaseConfig[] {
    return this.configs;
  }

  getConfig(dbId: string): DatabaseConfig | undefined {
    return this.configs.find((c) => c.id === dbId);
  }

  private getAdapter(dbId: string): DatabaseAdapter {
    const adapter = this.adapters.get(dbId);
    if (!adapter) {
      throw new Error(`Database not found: ${dbId}`);
    }
    return adapter;
  }

  private async connect(dbId: string): Promise<void> {
    const adapter = this.getAdapter(dbId);
    await adapter.connect();
  }

  private async ensureConnected(dbId: string): Promise<void> {
    const adapter = this.getAdapter(dbId);
    const connected = await adapter.testConnection();
    if (!connected) {
      await this.connect(dbId);
    }
  }

  async testConnection(dbId: string): Promise<boolean> {
    const adapter = this.getAdapter(dbId);
    return adapter.testConnection();
  }

  async getVersion(dbId: string): Promise<string> {
    await this.ensureConnected(dbId);
    const adapter = this.getAdapter(dbId);
    return adapter.getVersion();
  }

  async introspectSchema(
    dbId: string,
    forceRefresh: boolean = false,
    options?: IntrospectionOptions
  ): Promise<CacheEntry> {
    // Check cache first
    if (!forceRefresh) {
      const cached = await this.cache.get(dbId);
      if (cached) {
        this.logger.debug({ dbId }, 'Using cached schema');
        return cached;
      }
    }

    // Acquire lock to prevent concurrent introspection
    const releaseLock = await this.cache.acquireIntrospectionLock(dbId);

    try {
      // Double-check cache after acquiring lock
      if (!forceRefresh) {
        const cached = await this.cache.get(dbId);
        if (cached) {
          return cached;
        }
      }

      this.logger.info({ dbId, forceRefresh }, 'Introspecting schema');

      await this.ensureConnected(dbId);
      const adapter = this.getAdapter(dbId);
      const schema = await adapter.introspect(options);

      // Cache the result
      const config = this.getConfig(dbId);
      await this.cache.set(dbId, schema, config?.introspection?.maxTables);

      const entry = await this.cache.get(dbId);
      return entry!;
    } finally {
      releaseLock();
    }
  }

  async getSchema(dbId: string): Promise<CacheEntry> {
    // Ensure schema is cached
    return this.introspectSchema(dbId, false);
  }

  async runQuery(
    dbId: string,
    sql: string,
    params: any[] = [],
    timeoutMs?: number
  ): Promise<QueryResult> {
    const config = this.getConfig(dbId);
    
    // Check if write operation
    if (isWriteOperation(sql)) {
      if (!this.options.allowWrite && !config?.readOnly === false) {
        throw new Error('Write operations are not allowed. Set allowWrite in config.');
      }

      // Check allowed operations
      if (this.options.allowedWriteOperations && this.options.allowedWriteOperations.length > 0) {
        const operation = sql.trim().split(/\s+/)[0].toUpperCase();
        if (!this.options.allowedWriteOperations.includes(operation)) {
          throw new Error(`Write operation ${operation} is not allowed.`);
        }
      }
    }

    // Ensure schema is cached (for relationship annotation)
    await this.introspectSchema(dbId, false);

    await this.ensureConnected(dbId);
    const adapter = this.getAdapter(dbId);

    try {
      const result = await adapter.query(sql, params, timeoutMs);
      
      // Track query
      this.queryTracker.track(dbId, sql, result.executionTimeMs, result.rowCount);

      return result;
    } catch (error: any) {
      // Track error
      this.queryTracker.track(dbId, sql, 0, 0, error.message);
      throw error;
    }
  }

  async explainQuery(dbId: string, sql: string, params: any[] = []): Promise<any> {
    await this.ensureConnected(dbId);
    const adapter = this.getAdapter(dbId);
    return adapter.explain(sql, params);
  }

  async suggestJoins(dbId: string, tables: string[]): Promise<any[]> {
    const cacheEntry = await this.getSchema(dbId);
    return findJoinPaths(tables, cacheEntry.relationships);
  }

  async clearCache(dbId?: string): Promise<void> {
    await this.cache.clear(dbId);
    this.queryTracker.clear(dbId);
  }

  async getCacheStatus(dbId?: string): Promise<any[]> {
    return this.cache.getStatus(dbId);
  }

  getQueryStats(dbId: string): any {
    return this.queryTracker.getStats(dbId);
  }

  getQueryHistory(dbId: string, limit?: number): any[] {
    return this.queryTracker.getHistory(dbId, limit);
  }
}
