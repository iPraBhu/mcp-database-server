import fs from 'fs/promises';
import { dirname, resolve } from 'path';
import initSqlJs from 'sql.js';
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

type SqlJsModule = Awaited<ReturnType<typeof initSqlJs>>;
type SqlJsDatabase = InstanceType<SqlJsModule['Database']>;
type SqlJsStatement = ReturnType<SqlJsDatabase['prepare']>;

let sqlJsModulePromise: Promise<SqlJsModule> | undefined;

async function getSqlJsModule(): Promise<SqlJsModule> {
  sqlJsModulePromise ??= initSqlJs();
  return sqlJsModulePromise;
}

export class SQLiteAdapter extends BaseAdapter {
  private db?: SqlJsDatabase;
  private dbPath?: string;
  private fileBacked = false;
  private dirty = false;

  async connect(): Promise<void> {
    try {
      const configuredPath = this._config.path || this._config.url;
      if (!configuredPath) {
        throw new Error('SQLite requires path or url configuration');
      }

      const SQL = await getSqlJsModule();
      const isInMemory = configuredPath === ':memory:';
      const dbPath = isInMemory ? configuredPath : resolve(configuredPath);
      let fileContents: Buffer | undefined;

      if (!isInMemory) {
        try {
          fileContents = await fs.readFile(dbPath);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') {
            throw error;
          }
          if (this._config.readOnly) {
            throw new Error(`SQLite database file not found: ${dbPath}`);
          }
        }
      }

      this.db = fileContents
        ? new SQL.Database(new Uint8Array(fileContents))
        : new SQL.Database();
      this.db.exec('PRAGMA foreign_keys = ON');

      this.dbPath = dbPath;
      this.fileBacked = !isInMemory;
      this.dirty = false;
      this.connected = true;
      this.logger.info({ dbId: this._config.id, path: dbPath }, 'SQLite connected');
    } catch (error) {
      this.handleError(error, 'connect');
    }
  }

  async disconnect(): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      await this.persistToDisk(true);
      this.db.close();
    } finally {
      this.db = undefined;
      this.dbPath = undefined;
      this.fileBacked = false;
      this.dirty = false;
      this.connected = false;
      this.logger.info({ dbId: this._config.id }, 'SQLite disconnected');
    }
  }

  async introspect(options?: IntrospectionOptions): Promise<DatabaseSchema> {
    this.ensureConnected();

    try {
      const schemas = await this.getSchemas(options);
      const dbSchema: DatabaseSchema = {
        dbId: this._config.id,
        dbType: 'sqlite',
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
    const tables = await this.getTables('main', options);
    return [
      {
        name: 'main',
        tables,
      },
    ];
  }

  private async getTables(
    schemaName: string,
    options?: IntrospectionOptions
  ): Promise<TableMetadata[]> {
    const result: TableMetadata[] = [];
    const tableTypes = options?.includeViews ? "'table', 'view'" : "'table'";

    let query = `
      SELECT name, type
      FROM sqlite_master
      WHERE type IN (${tableTypes})
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;

    if (options?.maxTables) {
      query += ` LIMIT ${options.maxTables}`;
    }

    const { rows } = this.runReadStatement<Array<{ name: string; type: string }>>(query);

    for (const table of rows) {
      const columns = await this.getColumns(table.name);
      const indexes = await this.getIndexes(table.name);
      const foreignKeys = await this.getForeignKeys(table.name);

      const primaryKey = indexes.find((idx) => idx.isPrimary);

      result.push({
        schema: schemaName,
        name: table.name,
        type: table.type === 'view' ? 'view' : 'table',
        columns,
        primaryKey,
        indexes: indexes.filter((idx) => !idx.isPrimary),
        foreignKeys,
      });
    }

    return result;
  }

  private async getColumns(tableName: string): Promise<ColumnMetadata[]> {
    const safeTableName = this.quoteIdentifier(tableName);
    const { rows } = this.runReadStatement<
      Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>
    >(`PRAGMA table_info(${safeTableName})`);

    return rows.map((col) => ({
      name: col.name,
      dataType: col.type || 'TEXT',
      nullable: col.notnull === 0,
      defaultValue: col.dflt_value || undefined,
      isAutoIncrement: col.pk === 1 && col.type.toUpperCase() === 'INTEGER',
    }));
  }

  private async getIndexes(tableName: string): Promise<IndexMetadata[]> {
    const result: IndexMetadata[] = [];
    const safeTableName = this.quoteIdentifier(tableName);
    const { rows: indexes } = this.runReadStatement<
      Array<{
        name: string;
        unique: number;
        origin: string;
      }>
    >(`PRAGMA index_list(${safeTableName})`);

    for (const index of indexes) {
      const safeIndexName = this.quoteIdentifier(index.name);
      const { rows: indexInfo } = this.runReadStatement<
        Array<{
          seqno: number;
          cid: number;
          name: string;
        }>
      >(`PRAGMA index_info(${safeIndexName})`);

      result.push({
        name: index.name,
        columns: indexInfo.map((info) => info.name),
        isUnique: index.unique === 1,
        isPrimary: index.origin === 'pk',
      });
    }

    return result;
  }

  private async getForeignKeys(tableName: string): Promise<ForeignKeyMetadata[]> {
    const safeTableName = this.quoteIdentifier(tableName);
    const { rows: foreignKeys } = this.runReadStatement<
      Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>
    >(`PRAGMA foreign_key_list(${safeTableName})`);

    const grouped = new Map<number, typeof foreignKeys>();
    for (const fk of foreignKeys) {
      if (!grouped.has(fk.id)) {
        grouped.set(fk.id, []);
      }
      grouped.get(fk.id)!.push(fk);
    }

    return Array.from(grouped.values()).map((fks) => ({
      name: `fk_${tableName}_${fks[0].id}`,
      columns: fks.map((fk) => fk.from),
      referencedSchema: 'main',
      referencedTable: fks[0].table,
      referencedColumns: fks.map((fk) => fk.to),
      onUpdate: fks[0].on_update,
      onDelete: fks[0].on_delete,
    }));
  }

  async query(sql: string, params: any[] = [], _timeoutMs?: number): Promise<QueryResult> {
    this.ensureConnected();

    const startTime = Date.now();
    try {
      const stmt = this.prepareStatement(sql);
      try {
        const isSelect = sql.trim().toUpperCase().startsWith('SELECT');

        if (isSelect) {
          const { rows, columns } = this.collectRows(stmt, params);
          return {
            rows,
            columns,
            rowCount: rows.length,
            executionTimeMs: Date.now() - startTime,
            affectedRows: 0,
          };
        }

        this.runStatement(stmt, params);
        const affectedRows = this.db!.getRowsModified();
        this.dirty = this.dirty || affectedRows > 0;
        await this.persistToDisk();

        return {
          rows: [],
          columns: [],
          rowCount: 0,
          executionTimeMs: Date.now() - startTime,
          affectedRows,
        };
      } finally {
        stmt.free();
      }
    } catch (error) {
      this.handleError(error, 'query');
    }
  }

  async explain(sql: string, params: any[] = []): Promise<ExplainResult> {
    this.ensureConnected();

    try {
      const { rows } = this.runReadStatement(`EXPLAIN QUERY PLAN ${sql}`, params);
      return {
        plan: rows,
        formattedPlan: JSON.stringify(rows, null, 2),
      };
    } catch (error) {
      this.handleError(error, 'explain');
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.db) {
        return false;
      }
      const stmt = this.db.prepare('SELECT 1');
      try {
        stmt.step();
      } finally {
        stmt.free();
      }
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string> {
    this.ensureConnected();
    try {
      const { rows } = this.runReadStatement<Array<{ version: string }>>(
        'SELECT sqlite_version() as version'
      );
      return `SQLite ${rows[0].version}`;
    } catch (error) {
      this.handleError(error, 'getVersion');
    }
  }

  private prepareStatement(sql: string): SqlJsStatement {
    return this.db!.prepare(sql);
  }

  private runReadStatement<TRows extends Array<Record<string, unknown>>>(
    sql: string,
    params: any[] = []
  ): { rows: TRows; columns: string[] } {
    const stmt = this.prepareStatement(sql);
    try {
      return this.collectRows<TRows>(stmt, params);
    } finally {
      stmt.free();
    }
  }

  private collectRows<TRows extends Array<Record<string, unknown>>>(
    stmt: SqlJsStatement,
    params: any[] = []
  ): { rows: TRows; columns: string[] } {
    if (params.length > 0) {
      stmt.bind(params);
    }

    const columns = stmt.getColumnNames();
    const rows: Record<string, unknown>[] = [];

    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }

    return {
      rows: rows as TRows,
      columns,
    };
  }

  private runStatement(stmt: SqlJsStatement, params: any[] = []): void {
    if (params.length > 0) {
      stmt.run(params);
      return;
    }
    stmt.run();
  }

  private quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private async persistToDisk(force: boolean = false): Promise<void> {
    if (!this.db || !this.fileBacked || this._config.readOnly || (!force && !this.dirty)) {
      return;
    }

    await fs.mkdir(dirname(this.dbPath!), { recursive: true });
    const data = this.db.export();
    await fs.writeFile(this.dbPath!, Buffer.from(data));
    this.dirty = false;
  }
}
