import pg from 'pg';
import { BaseAdapter } from './base.js';
import {
  DatabaseSchema,
  QueryResult,
  ExplainResult,
  IntrospectionOptions,
  TableMetadata,
  ColumnMetadata,
  IndexMetadata,
  ForeignKeyMetadata,
  SchemaMetadata,
} from '../types.js';
import { generateSchemaVersion } from '../utils.js';

const { Pool } = pg;

export class PostgresAdapter extends BaseAdapter {
  private pool?: pg.Pool;

  async connect(): Promise<void> {
    try {
      this.pool = new Pool({
        connectionString: this._config.url,
        min: this._config.pool?.min || 2,
        max: this._config.pool?.max || 10,
        idleTimeoutMillis: this._config.pool?.idleTimeoutMillis || 30000,
        connectionTimeoutMillis: this._config.pool?.connectionTimeoutMillis || 10000,
      });

      // Test connection
      const client = await this.pool.connect();
      client.release();

      this.connected = true;
      this.logger.info({ dbId: this._config.id }, 'PostgreSQL connected');
    } catch (error) {
      this.handleError(error, 'connect');
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
      this.connected = false;
      this.logger.info({ dbId: this._config.id }, 'PostgreSQL disconnected');
    }
  }

  async introspect(options?: IntrospectionOptions): Promise<DatabaseSchema> {
    this.ensureConnected();

    try {
      const schemas = await this.getSchemas(options);
      const dbSchema: DatabaseSchema = {
        dbId: this._config.id,
        dbType: 'postgres',
        schemas,
        introspectedAt: new Date(),
        version: '',
      };

      dbSchema.version = generateSchemaVersion(dbSchema);
      return dbSchema;
    } catch (error) {
      this.handleError(error, 'introspect');
    }
  }

  private async getSchemas(options?: IntrospectionOptions): Promise<SchemaMetadata[]> {
    const result: SchemaMetadata[] = [];

    // Get all schemas
    const schemasQuery = `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY schema_name
    `;

    const schemasResult = await this.pool!.query(schemasQuery);
    let schemaNames = schemasResult.rows.map((r) => r.schema_name);

    // Apply filters
    if (options?.includeSchemas && options.includeSchemas.length > 0) {
      schemaNames = schemaNames.filter((s) => options.includeSchemas!.includes(s));
    }
    if (options?.excludeSchemas && options.excludeSchemas.length > 0) {
      schemaNames = schemaNames.filter((s) => !options.excludeSchemas!.includes(s));
    }

    for (const schemaName of schemaNames) {
      const tables = await this.getTables(schemaName, options);
      result.push({
        name: schemaName,
        tables,
      });
    }

    return result;
  }

  private async getTables(
    schemaName: string,
    options?: IntrospectionOptions
  ): Promise<TableMetadata[]> {
    const result: TableMetadata[] = [];

    // Get tables and views
    let tableTypes = "'BASE TABLE'";
    if (options?.includeViews) {
      tableTypes += ",'VIEW'";
    }

    const tablesQuery = `
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_type IN (${tableTypes})
      ORDER BY table_name
      ${options?.maxTables ? `LIMIT ${options.maxTables}` : ''}
    `;

    const tablesResult = await this.pool!.query(tablesQuery, [schemaName]);

    for (const row of tablesResult.rows) {
      const columns = await this.getColumns(schemaName, row.table_name);
      const indexes = await this.getIndexes(schemaName, row.table_name);
      const foreignKeys = await this.getForeignKeys(schemaName, row.table_name);

      const primaryKey = indexes.find((idx) => idx.isPrimary);

      result.push({
        schema: schemaName,
        name: row.table_name,
        type: row.table_type === 'VIEW' ? 'view' : 'table',
        columns,
        primaryKey,
        indexes: indexes.filter((idx) => !idx.isPrimary),
        foreignKeys,
      });
    }

    return result;
  }

  private async getColumns(schemaName: string, tableName: string): Promise<ColumnMetadata[]> {
    const query = `
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        is_identity
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `;

    const result = await this.pool!.query(query, [schemaName, tableName]);

    return result.rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      maxLength: row.character_maximum_length,
      precision: row.numeric_precision,
      scale: row.numeric_scale,
      isAutoIncrement: row.is_identity === 'YES',
    }));
  }

  private async getIndexes(schemaName: string, tableName: string): Promise<IndexMetadata[]> {
    const query = `
      SELECT
        i.relname AS index_name,
        ix.indisunique AS is_unique,
        ix.indisprimary AS is_primary,
        array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS column_names
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2
      GROUP BY i.relname, ix.indisunique, ix.indisprimary
    `;

    const result = await this.pool!.query(query, [schemaName, tableName]);

    return result.rows.map((row) => ({
      name: row.index_name,
      columns: row.column_names,
      isUnique: row.is_unique,
      isPrimary: row.is_primary,
    }));
  }

  private async getForeignKeys(
    schemaName: string,
    tableName: string
  ): Promise<ForeignKeyMetadata[]> {
    const query = `
      SELECT
        tc.constraint_name,
        array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS column_names,
        ccu.table_schema AS referenced_schema,
        ccu.table_name AS referenced_table,
        array_agg(ccu.column_name ORDER BY kcu.ordinal_position) AS referenced_columns,
        rc.update_rule,
        rc.delete_rule
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
        AND tc.table_name = $2
      GROUP BY tc.constraint_name, ccu.table_schema, ccu.table_name, rc.update_rule, rc.delete_rule
    `;

    const result = await this.pool!.query(query, [schemaName, tableName]);

    return result.rows.map((row) => ({
      name: row.constraint_name,
      columns: row.column_names,
      referencedSchema: row.referenced_schema,
      referencedTable: row.referenced_table,
      referencedColumns: row.referenced_columns,
      onUpdate: row.update_rule,
      onDelete: row.delete_rule,
    }));
  }

  async query(sql: string, params: any[] = [], timeoutMs?: number): Promise<QueryResult> {
    this.ensureConnected();

    const startTime = Date.now();
    try {
      const queryConfig: any = {
        text: sql,
        values: params,
      };

      if (timeoutMs) {
        queryConfig.statement_timeout = timeoutMs;
      }

      const result = await this.pool!.query(queryConfig);
      const executionTimeMs = Date.now() - startTime;

      return {
        rows: result.rows,
        columns: result.fields.map((f: any) => f.name),
        rowCount: result.rowCount || 0,
        executionTimeMs,
        affectedRows: result.rowCount || 0,
      };
    } catch (error) {
      this.handleError(error, 'query');
    }
  }

  async explain(sql: string, params: any[] = []): Promise<ExplainResult> {
    this.ensureConnected();

    try {
      const explainSql = `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${sql}`;
      const result = await this.pool!.query(explainSql, params);

      return {
        plan: result.rows[0]['QUERY PLAN'],
        formattedPlan: JSON.stringify(result.rows[0]['QUERY PLAN'], null, 2),
      };
    } catch (error) {
      this.handleError(error, 'explain');
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.pool) return false;
      const client = await this.pool.connect();
      client.release();
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string> {
    this.ensureConnected();
    try {
      const result = await this.pool!.query('SELECT version()');
      return result.rows[0].version;
    } catch (error) {
      this.handleError(error, 'getVersion');
    }
  }
}
