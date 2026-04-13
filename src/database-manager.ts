import {
  DatabaseAdapter,
  DatabaseConfig,
  IntrospectionOptions,
  QueryResult,
  QueryStreamHandlers,
  StreamQueryResult,
} from './types.js';
import { createAdapter } from './adapters/index.js';
import { SchemaCache, CacheEntry } from './cache.js';
import { QueryTracker } from './query-tracker.js';
import {
  extractTableNames,
  isWriteOperation,
  findJoinPaths,
  getSqlOperation,
  isReadOnlyQuery,
} from './utils.js';
import { getLogger } from './logger.js';

const AUTO_EXPLAIN_THRESHOLD_MS = 1000;

export interface DatabaseManagerOptions {
  cacheDir: string;
  cacheTtlMinutes: number;
  allowWrite: boolean;
  allowedWriteOperations?: string[];
  disableDangerousOperations: boolean;
}

export class DatabaseManager {
  private logger = getLogger();
  private adapters = new Map<string, DatabaseAdapter>();
  private cache: SchemaCache;
  private queryTracker = new QueryTracker();

  constructor(
    private _configs: DatabaseConfig[],
    private options: DatabaseManagerOptions
  ) {
    this.cache = new SchemaCache(options.cacheDir, options.cacheTtlMinutes);
  }

  async init(): Promise<void> {
    await this.cache.init();

    // Create adapters
    for (const config of this._configs) {
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

    this.logger.info({ databases: this._configs.length }, 'Database manager initialized');
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
    return this._configs;
  }

  getConfig(dbId: string): DatabaseConfig | undefined {
    return this._configs.find((c) => c.id === dbId);
  }

  getCacheDir(): string {
    return this.options.cacheDir;
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
    if (!adapter.isConnected()) {
      await this.connect(dbId);
    }
  }

  private async reconnect(dbId: string): Promise<void> {
    const adapter = this.getAdapter(dbId);
    try {
      await adapter.disconnect();
    } catch (error) {
      this.logger.warn({ dbId, error }, 'Disconnect during reconnect failed');
    }

    await adapter.connect();
  }

  private isRetryableConnectionError(error: any): boolean {
    const code = error?._code || error?.code;
    return [
      'NOT_CONNECTED',
      'PROTOCOL_CONNECTION_LOST',
      'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
      'PROTOCOL_ENQUEUE_AFTER_QUIT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ETIMEDOUT',
    ].includes(code);
  }

  private async executeReadWithRecovery<T>(dbId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!this.isRetryableConnectionError(error)) {
        throw error;
      }

      this.logger.warn({ dbId, error }, 'Retrying read operation after reconnect');
      await this.reconnect(dbId);
      return await operation();
    }
  }

  async testConnection(dbId: string): Promise<boolean> {
    try {
      await this.ensureConnected(dbId);
      return true;
    } catch {
      return false;
    }
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
    const config = this.getConfig(dbId);
    const introspectionOptions: IntrospectionOptions | undefined =
      config?.introspection || options
        ? {
            includeViews: options?.includeViews ?? config?.introspection?.includeViews ?? true,
            includeRoutines:
              options?.includeRoutines ?? config?.introspection?.includeRoutines ?? false,
            maxTables: options?.maxTables ?? config?.introspection?.maxTables,
            excludeSchemas: options?.excludeSchemas ?? config?.introspection?.excludeSchemas,
            includeSchemas: options?.includeSchemas ?? config?.introspection?.includeSchemas,
          }
        : undefined;

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
      const schema = await adapter.introspect(introspectionOptions);

      // Cache the result
      await this.cache.set(dbId, schema);

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
    timeoutMs?: number,
    includeSchemaContext: boolean = true,
    trackQuery: boolean = true
  ): Promise<QueryResult> {
    this.validateQueryAccess(dbId, sql, 'execute');
    const writeOperation = isWriteOperation(sql);
    const readOnlyQuery = isReadOnlyQuery(sql);
    const referencedTables = readOnlyQuery ? extractTableNames(sql) : [];

    // Ensure schema is cached (for relationship annotation)
    if (includeSchemaContext && readOnlyQuery && referencedTables.length > 0) {
      await this.introspectSchema(dbId, false);
    }

    await this.ensureConnected(dbId);
    const adapter = this.getAdapter(dbId);

    try {
      const result = readOnlyQuery
        ? await this.executeReadWithRecovery(dbId, async () => adapter.query(sql, params, timeoutMs))
        : await adapter.query(sql, params, timeoutMs);

      // Collect EXPLAIN only for slow read-only queries to avoid doubling fast-query latency.
      let explainPlan;
      if (trackQuery && readOnlyQuery && result.executionTimeMs >= AUTO_EXPLAIN_THRESHOLD_MS) {
        try {
          explainPlan = await this.executeReadWithRecovery(dbId, async () =>
            adapter.explain(sql, params)
          );
        } catch (_explainError) {
          // EXPLAIN might not be supported or might fail, continue without it
          this.logger.debug({ dbId, sql }, 'EXPLAIN failed, continuing without performance analysis');
        }
      }
      
      // Track query with performance data
      if (trackQuery) {
        this.queryTracker.track(
          dbId,
          sql,
          result.executionTimeMs,
          result.rowCount,
          undefined,
          explainPlan
        );
      }

      if (writeOperation) {
        await this.cache.clear(dbId);
      }

      return result;
    } catch (error: any) {
      // Track error
      if (trackQuery) {
        this.queryTracker.track(dbId, sql, 0, 0, error.message);
      }
      throw error;
    }
  }

  async explainQuery(dbId: string, sql: string, params: any[] = []): Promise<any> {
    this.validateQueryAccess(dbId, sql, 'analyze');
    await this.ensureConnected(dbId);
    const adapter = this.getAdapter(dbId);
    return this.executeReadWithRecovery(dbId, async () => adapter.explain(sql, params));
  }

  async runReadQueryPage(
    dbId: string,
    sql: string,
    params: any[] = [],
    timeoutMs?: number
  ): Promise<QueryResult> {
    this.validateQueryAccess(dbId, sql, 'analyze');
    await this.ensureConnected(dbId);
    const adapter = this.getAdapter(dbId);
    return this.executeReadWithRecovery(dbId, async () => adapter.query(sql, params, timeoutMs));
  }

  async streamReadQuery(
    dbId: string,
    sql: string,
    params: any[] = [],
    timeoutMs: number | undefined,
    handlers: QueryStreamHandlers
  ): Promise<StreamQueryResult | null> {
    this.validateQueryAccess(dbId, sql, 'analyze');
    await this.ensureConnected(dbId);
    const adapter = this.getAdapter(dbId);

    if (!adapter.streamQuery) {
      return null;
    }

    return this.executeReadWithRecovery(dbId, async () =>
      adapter.streamQuery!(sql, params, timeoutMs, handlers)
    );
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

  getPerformanceAnalytics(dbId: string): any {
    return this.queryTracker.getPerformanceAnalytics(dbId);
  }

  async getIndexRecommendations(dbId: string): Promise<any[]> {
    const cacheEntry = await this.getSchema(dbId);
    return this.queryTracker.getIndexRecommendations(dbId, cacheEntry.schema);
  }

  getSlowQueryAlerts(dbId: string): any[] {
    return this.queryTracker.getSlowQueryAlerts(dbId);
  }

  async suggestQueryRewrite(dbId: string, sql: string): Promise<any> {
    const cacheEntry = await this.getSchema(dbId);
    return this.queryTracker.suggestQueryRewrite(sql, cacheEntry.schema);
  }

  async profileQueryPerformance(dbId: string, sql: string, params: any[] = []): Promise<any> {
    this.validateQueryAccess(dbId, sql, 'analyze');
    await this.ensureConnected(dbId);
    const adapter = this.getAdapter(dbId);
    
    // Execute query to get timing
    const startTime = Date.now();
    const result = await this.executeReadWithRecovery(dbId, async () => adapter.query(sql, params));
    const executionTimeMs = Date.now() - startTime;
    
    // Get EXPLAIN plan
    const explainResult = await this.executeReadWithRecovery(dbId, async () =>
      adapter.explain(sql, params)
    );
    
    return this.queryTracker.profileQueryPerformance(dbId, sql, explainResult, executionTimeMs, result.rowCount);
  }

  private validateQueryAccess(
    dbId: string,
    sql: string,
    mode: 'execute' | 'analyze'
  ): void {
    const config = this.getConfig(dbId);
    const operation = getSqlOperation(sql);
    const dangerousOps = ['DELETE', 'TRUNCATE', 'DROP'];

    if (mode === 'analyze' && !isReadOnlyQuery(sql)) {
      throw new Error('Only read-only SELECT queries can be explained or profiled.');
    }

    if (!isWriteOperation(sql)) {
      return;
    }

    if (!this.options.allowWrite) {
      throw new Error('Write operations are not allowed. Set allowWrite in config.');
    }

    if (config?.readOnly !== false) {
      throw new Error(`Database ${dbId} is read-only. Set readOnly: false for this database to allow writes.`);
    }

    if (this.options.disableDangerousOperations && dangerousOps.includes(operation)) {
      throw new Error(
        `Dangerous operation ${operation} is disabled. Set disableDangerousOperations: false in security config to allow.`
      );
    }

    if (this.options.allowedWriteOperations && this.options.allowedWriteOperations.length > 0) {
      const allowedOperations = this.options.allowedWriteOperations.map((op) => op.toUpperCase());
      if (!allowedOperations.includes(operation)) {
        throw new Error(`Write operation ${operation} is not allowed.`);
      }
    }
  }
}
