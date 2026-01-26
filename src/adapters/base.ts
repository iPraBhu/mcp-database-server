import {
  DatabaseAdapter,
  DatabaseConfig,
  DatabaseSchema,
  QueryResult,
  ExplainResult,
  IntrospectionOptions,
  DatabaseError,
} from '../types.js';
import { getLogger } from '../logger.js';

export abstract class BaseAdapter implements DatabaseAdapter {
  protected logger = getLogger();
  protected connected = false;

  constructor(protected config: DatabaseConfig) {}

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract introspect(options?: IntrospectionOptions): Promise<DatabaseSchema>;
  abstract query(sql: string, params?: any[], timeoutMs?: number): Promise<QueryResult>;
  abstract explain(sql: string, params?: any[]): Promise<ExplainResult>;
  abstract testConnection(): Promise<boolean>;
  abstract getVersion(): Promise<string>;

  protected ensureConnected(): void {
    if (!this.connected) {
      throw new DatabaseError(
        'Database not connected',
        'NOT_CONNECTED',
        this.config.id
      );
    }
  }

  protected handleError(error: any, operation: string): never {
    this.logger.error({ error, dbId: this.config.id, operation }, 'Database operation failed');
    throw new DatabaseError(
      `${operation} failed: ${error.message}`,
      error.code || 'UNKNOWN_ERROR',
      this.config.id,
      error
    );
  }
}
