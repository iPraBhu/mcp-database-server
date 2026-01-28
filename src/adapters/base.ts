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

  constructor(protected _config: DatabaseConfig) {}

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract introspect(_options?: IntrospectionOptions): Promise<DatabaseSchema>;
  abstract query(_sql: string, _params?: any[], _timeoutMs?: number): Promise<QueryResult>;
  abstract explain(_sql: string, _params?: any[]): Promise<ExplainResult>;
  abstract testConnection(): Promise<boolean>;
  abstract getVersion(): Promise<string>;

  protected ensureConnected(): void {
    if (!this.connected) {
      throw new DatabaseError(
        'Database not connected',
        'NOT_CONNECTED',
        this._config.id
      );
    }
  }

  protected handleError(error: any, operation: string): never {
    this.logger.error({ error, dbId: this._config.id, operation }, 'Database operation failed');
    throw new DatabaseError(
      `${operation} failed: ${error.message}`,
      error.code || 'UNKNOWN_ERROR',
      this._config.id,
      error
    );
  }
}
