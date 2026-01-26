import mysql from 'mysql2/promise';
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

export class MySQLAdapter extends BaseAdapter {
  private pool?: mysql.Pool;
  private database?: string;

  async connect(): Promise<void> {
    try {
      this.pool = mysql.createPool({
        uri: this.config.url,
        waitForConnections: true,
        connectionLimit: this.config.pool?.max || 10,
        queueLimit: 0,
        connectTimeout: this.config.pool?.connectionTimeoutMillis || 10000,
      });

      // Test connection and get database name
      const connection = await this.pool.getConnection();
      const [rows] = await connection.query('SELECT DATABASE() as db');
      this.database = (rows as any)[0].db;
      connection.release();

      this.connected = true;
      this.logger.info({ dbId: this.config.id }, 'MySQL connected');
    } catch (error) {
      this.handleError(error, 'connect');
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
      this.connected = false;
      this.logger.info({ dbId: this.config.id }, 'MySQL disconnected');
    }
  }

  async introspect(options?: IntrospectionOptions): Promise<DatabaseSchema> {
    this.ensureConnected();

    try {
      const schemas = await this.getSchemas(options);
      const dbSchema: DatabaseSchema = {
        dbId: this.config.id,
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
    const result: TableMetadata[] = [];

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

    for (const row of rows as any[]) {
      const columns = await this.getColumns(schemaName, row.TABLE_NAME);
      const indexes = await this.getIndexes(schemaName, row.TABLE_NAME);
      const foreignKeys = await this.getForeignKeys(schemaName, row.TABLE_NAME);

      const primaryKey = indexes.find((idx) => idx.isPrimary);

      result.push({
        schema: schemaName,
        name: row.TABLE_NAME,
        type: row.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
        columns,
        primaryKey,
        indexes: indexes.filter((idx) => !idx.isPrimary),
        foreignKeys,
        comment: row.TABLE_COMMENT,
      });
    }

    return result;
  }

  private async getColumns(schemaName: string, tableName: string): Promise<ColumnMetadata[]> {
    const query = `
      SELECT
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
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;

    const [rows] = await this.pool!.query(query, [schemaName, tableName]);

    return (rows as any[]).map((row) => ({
      name: row.COLUMN_NAME,
      dataType: row.DATA_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      maxLength: row.CHARACTER_MAXIMUM_LENGTH,
      precision: row.NUMERIC_PRECISION,
      scale: row.NUMERIC_SCALE,
      isAutoIncrement: row.EXTRA.includes('auto_increment'),
      comment: row.COLUMN_COMMENT,
    }));
  }

  private async getIndexes(schemaName: string, tableName: string): Promise<IndexMetadata[]> {
    const query = `
      SELECT
        INDEX_NAME,
        NON_UNIQUE,
        GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS column_names
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      GROUP BY INDEX_NAME, NON_UNIQUE
    `;

    const [rows] = await this.pool!.query(query, [schemaName, tableName]);

    return (rows as any[]).map((row) => ({
      name: row.INDEX_NAME,
      columns: row.column_names.split(','),
      isUnique: row.NON_UNIQUE === 0,
      isPrimary: row.INDEX_NAME === 'PRIMARY',
    }));
  }

  private async getForeignKeys(
    schemaName: string,
    tableName: string
  ): Promise<ForeignKeyMetadata[]> {
    const query = `
      SELECT
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
      WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      GROUP BY kcu.CONSTRAINT_NAME, kcu.REFERENCED_TABLE_SCHEMA,
               kcu.REFERENCED_TABLE_NAME, rc.UPDATE_RULE, rc.DELETE_RULE
    `;

    const [rows] = await this.pool!.query(query, [schemaName, tableName]);

    return (rows as any[]).map((row) => ({
      name: row.CONSTRAINT_NAME,
      columns: row.column_names.split(','),
      referencedSchema: row.REFERENCED_TABLE_SCHEMA,
      referencedTable: row.REFERENCED_TABLE_NAME,
      referencedColumns: row.referenced_columns.split(','),
      onUpdate: row.UPDATE_RULE,
      onDelete: row.DELETE_RULE,
    }));
  }

  async query(sql: string, params: any[] = [], timeoutMs?: number): Promise<QueryResult> {
    this.ensureConnected();

    const startTime = Date.now();
    try {
      const connection = await this.pool!.getConnection();
      
      if (timeoutMs) {
        await connection.query(`SET SESSION max_execution_time=${timeoutMs}`);
      }

      const [rows, fields] = await connection.query(sql, params);
      connection.release();

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
    }
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
