import mysql from 'mysql2/promise';
import { BaseAdapter } from './base.js';
import {
  DatabaseSchema,
  QueryResult,
  QueryStreamHandlers,
  ExplainResult,
  IntrospectionOptions,
  TableMetadata,
  ColumnMetadata,
  IndexMetadata,
  ForeignKeyMetadata,
  SchemaMetadata,
  StreamQueryResult,
} from '../types.js';
import { generateSchemaVersion } from '../utils.js';

export class MySQLAdapter extends BaseAdapter {
  private pool?: mysql.Pool;
  private database?: string;

  async connect(): Promise<void> {
    try {
      const connectionLimit = this._config.pool?.max || 10;
      this.pool = mysql.createPool({
        uri: this._config.url,
        waitForConnections: true,
        connectionLimit,
        maxIdle: connectionLimit,
        idleTimeout: this._config.pool?.idleTimeoutMillis || 60000,
        queueLimit: 0,
        connectTimeout: this._config.pool?.connectionTimeoutMillis || 10000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
      });

      // Test connection and get database name
      const connection = await this.pool.getConnection();
      const [rows] = await connection.query('SELECT DATABASE() as db');
      this.database = (rows as any)[0].db;
      connection.release();

      this.connected = true;
      this.logger.info({ dbId: this._config.id }, 'MySQL connected');
    } catch (error) {
      this.handleError(error, 'connect');
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
      this.connected = false;
      this.logger.info({ dbId: this._config.id }, 'MySQL disconnected');
    }
  }

  async introspect(options?: IntrospectionOptions): Promise<DatabaseSchema> {
    this.ensureConnected();

    try {
      const schemas = await this.getSchemas(options);
      const dbSchema: DatabaseSchema = {
        dbId: this._config.id,
        dbType: 'mysql',
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
    // MySQL uses the current database as the schema
    const tables = await this.getTables(this.database!, options);
    return [
      {
        name: this.database!,
        tables,
      },
    ];
  }

  private async getTables(
    schemaName: string,
    options?: IntrospectionOptions
  ): Promise<TableMetadata[]> {
    let tableTypes = "'BASE TABLE'";
    if (options?.includeViews) {
      tableTypes += ",'VIEW'";
    }

    const tablesQuery = `
      SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (${tableTypes})
      ORDER BY TABLE_NAME
      ${options?.maxTables ? `LIMIT ${options.maxTables}` : ''}
    `;

    const [rows] = await this.pool!.query(tablesQuery, [schemaName]);
    const tableRows = rows as any[];
    const tableNames = tableRows.map((row) => row.TABLE_NAME);

    if (tableNames.length === 0) {
      return [];
    }

    const [columnsByTable, indexesByTable, foreignKeysByTable] = await Promise.all([
      this.getColumnsByTable(schemaName, tableNames),
      this.getIndexesByTable(schemaName, tableNames),
      this.getForeignKeysByTable(schemaName, tableNames),
    ]);

    return tableRows.map((row) => {
      const columns = columnsByTable.get(row.TABLE_NAME) || [];
      const indexes = indexesByTable.get(row.TABLE_NAME) || [];
      const foreignKeys = foreignKeysByTable.get(row.TABLE_NAME) || [];
      const primaryKey = indexes.find((idx) => idx.isPrimary);

      return {
        schema: schemaName,
        name: row.TABLE_NAME,
        type: row.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
        columns,
        primaryKey,
        indexes: indexes.filter((idx) => !idx.isPrimary),
        foreignKeys,
        comment: row.TABLE_COMMENT,
      };
    });
  }

  private async getColumnsByTable(
    schemaName: string,
    tableNames: string[]
  ): Promise<Map<string, ColumnMetadata[]>> {
    const placeholders = tableNames.map(() => '?').join(', ');
    const query = `
      SELECT
        TABLE_NAME,
        COLUMN_NAME,
        DATA_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        CHARACTER_MAXIMUM_LENGTH,
        NUMERIC_PRECISION,
        NUMERIC_SCALE,
        EXTRA,
        COLUMN_COMMENT
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `;

    const [rows] = await this.pool!.query(query, [schemaName, ...tableNames]);
    const columnsByTable = new Map<string, ColumnMetadata[]>();

    for (const row of rows as any[]) {
      const columns = columnsByTable.get(row.TABLE_NAME) || [];
      columns.push({
        name: row.COLUMN_NAME,
        dataType: row.DATA_TYPE,
        nullable: row.IS_NULLABLE === 'YES',
        defaultValue: row.COLUMN_DEFAULT,
        maxLength: row.CHARACTER_MAXIMUM_LENGTH,
        precision: row.NUMERIC_PRECISION,
        scale: row.NUMERIC_SCALE,
        isAutoIncrement: row.EXTRA.includes('auto_increment'),
        comment: row.COLUMN_COMMENT,
      });
      columnsByTable.set(row.TABLE_NAME, columns);
    }

    return columnsByTable;
  }

  private async getIndexesByTable(
    schemaName: string,
    tableNames: string[]
  ): Promise<Map<string, IndexMetadata[]>> {
    const placeholders = tableNames.map(() => '?').join(', ');
    const query = `
      SELECT
        TABLE_NAME,
        INDEX_NAME,
        NON_UNIQUE,
        GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS column_names
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})
      GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE
      ORDER BY TABLE_NAME, INDEX_NAME
    `;

    const [rows] = await this.pool!.query(query, [schemaName, ...tableNames]);
    const indexesByTable = new Map<string, IndexMetadata[]>();

    for (const row of rows as any[]) {
      const indexes = indexesByTable.get(row.TABLE_NAME) || [];
      indexes.push({
        name: row.INDEX_NAME,
        columns: row.column_names.split(','),
        isUnique: row.NON_UNIQUE === 0,
        isPrimary: row.INDEX_NAME === 'PRIMARY',
      });
      indexesByTable.set(row.TABLE_NAME, indexes);
    }

    return indexesByTable;
  }

  private async getForeignKeysByTable(
    schemaName: string,
    tableNames: string[]
  ): Promise<Map<string, ForeignKeyMetadata[]>> {
    const placeholders = tableNames.map(() => '?').join(', ');
    const query = `
      SELECT
        kcu.TABLE_NAME,
        kcu.CONSTRAINT_NAME,
        GROUP_CONCAT(kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION) AS column_names,
        kcu.REFERENCED_TABLE_SCHEMA,
        kcu.REFERENCED_TABLE_NAME,
        GROUP_CONCAT(kcu.REFERENCED_COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION) AS referenced_columns,
        rc.UPDATE_RULE,
        rc.DELETE_RULE
      FROM information_schema.KEY_COLUMN_USAGE AS kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS AS rc
        ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
        AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
      WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME IN (${placeholders})
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      GROUP BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.REFERENCED_TABLE_SCHEMA,
               kcu.REFERENCED_TABLE_NAME, rc.UPDATE_RULE, rc.DELETE_RULE
      ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME
    `;

    const [rows] = await this.pool!.query(query, [schemaName, ...tableNames]);
    const foreignKeysByTable = new Map<string, ForeignKeyMetadata[]>();

    for (const row of rows as any[]) {
      const foreignKeys = foreignKeysByTable.get(row.TABLE_NAME) || [];
      foreignKeys.push({
        name: row.CONSTRAINT_NAME,
        columns: row.column_names.split(','),
        referencedSchema: row.REFERENCED_TABLE_SCHEMA,
        referencedTable: row.REFERENCED_TABLE_NAME,
        referencedColumns: row.referenced_columns.split(','),
        onUpdate: row.UPDATE_RULE,
        onDelete: row.DELETE_RULE,
      });
      foreignKeysByTable.set(row.TABLE_NAME, foreignKeys);
    }

    return foreignKeysByTable;
  }

  async query(sql: string, params: any[] = [], timeoutMs?: number): Promise<QueryResult> {
    this.ensureConnected();

    const startTime = Date.now();
    let connection: mysql.PoolConnection | undefined;
    try {
      connection = await this.pool!.getConnection();

      const [rows, fields] =
        params.length > 0
          ? await connection.execute(
              {
                sql,
                timeout: timeoutMs,
              },
              params
            )
          : await connection.query({
              sql,
              timeout: timeoutMs,
            });

      const executionTimeMs = Date.now() - startTime;

      return {
        rows: Array.isArray(rows) ? rows : [],
        columns: Array.isArray(fields) ? fields.map((f: any) => f.name) : [],
        rowCount: Array.isArray(rows) ? rows.length : 0,
        executionTimeMs,
        affectedRows: (rows as any).affectedRows,
      };
    } catch (error) {
      this.handleError(error, 'query');
      throw error;
    } finally {
      connection?.release();
    }
  }

  async streamQuery(
    sql: string,
    params: any[] = [],
    timeoutMs: number | undefined,
    handlers: QueryStreamHandlers
  ): Promise<StreamQueryResult> {
    this.ensureConnected();

    return await new Promise((resolve, reject) => {
      const startTime = Date.now();
      const corePool = (this.pool as any).pool;
      const query = corePool.query({
        sql,
        values: params,
        timeout: timeoutMs,
      });
      const stream = query.stream({ highWaterMark: 100 });
      let columns: string[] = [];
      let rowCount = 0;
      let settled = false;

      const finishWithError = (error: any) => {
        if (settled) return;
        settled = true;
        try {
          this.handleError(error, 'streamQuery');
        } catch (dbError) {
          reject(dbError);
        }
      };

      const finishWithResult = () => {
        if (settled) return;
        settled = true;
        resolve({
          columns,
          rowCount,
          executionTimeMs: Date.now() - startTime,
        });
      };

      stream.on('fields', (fields: any[]) => {
        stream.pause();
        columns = Array.isArray(fields) ? fields.map((field) => field.name) : [];
        Promise.resolve(handlers.onColumns?.(columns))
          .then(() => stream.resume())
          .catch((error) => stream.destroy(error instanceof Error ? error : new Error(String(error))));
      });

      stream.on('data', (row: any) => {
        stream.pause();
        Promise.resolve(handlers.onRow(row))
          .then(() => {
            rowCount++;
            stream.resume();
          })
          .catch((error) => stream.destroy(error instanceof Error ? error : new Error(String(error))));
      });

      stream.once('end', finishWithResult);
      stream.once('error', finishWithError);
    });
  }

  async explain(sql: string, params: any[] = []): Promise<ExplainResult> {
    this.ensureConnected();

    try {
      const explainSql = `EXPLAIN FORMAT=JSON ${sql}`;
      const [rows] = await this.pool!.query(explainSql, params);

      return {
        plan: (rows as any)[0].EXPLAIN,
        formattedPlan: JSON.stringify((rows as any)[0].EXPLAIN, null, 2),
      };
    } catch (error) {
      this.handleError(error, 'explain');
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.pool) return false;
      const connection = await this.pool.getConnection();
      connection.release();
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string> {
    this.ensureConnected();
    try {
      const [rows] = await this.pool!.query('SELECT VERSION() as version');
      return (rows as any)[0].version;
    } catch (error) {
      this.handleError(error, 'getVersion');
    }
  }
}
