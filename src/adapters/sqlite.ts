import Database from 'better-sqlite3';
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

export class SQLiteAdapter extends BaseAdapter {
  private db?: Database.Database;

  async connect(): Promise<void> {
    try {
      const dbPath = this.config.path || this.config.url;
      if (!dbPath) {
        throw new Error('SQLite requires path or url configuration');
      }

      this.db = new Database(dbPath, {
        readonly: this.config.readOnly,
        fileMustExist: false,
      });

      // Enable foreign keys
      this.db.pragma('foreign_keys = ON');

      this.connected = true;
      this.logger.info({ dbId: this.config.id, path: dbPath }, 'SQLite connected');
    } catch (error) {
      this.handleError(error, 'connect');
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
      this.connected = false;
      this.logger.info({ dbId: this.config.id }, 'SQLite disconnected');
    }
  }

  async introspect(options?: IntrospectionOptions): Promise<DatabaseSchema> {
    this.ensureConnected();

    try {
      const schemas = await this.getSchemas(options);
      const dbSchema: DatabaseSchema = {
        dbId: this.config.id,
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

    let query = `
      SELECT name, type
      FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;

    if (options?.maxTables) {
      query += ` LIMIT ${options.maxTables}`;
    }

    const tables = this.db!.prepare(query).all() as Array<{ name: string; type: string }>;

    for (const table of tables) {
      if (table.type === 'view' && !options?.includeViews) {
        continue;
      }

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
    const pragma = this.db!.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    return pragma.map((col) => ({
      name: col.name,
      dataType: col.type || 'TEXT',
      nullable: col.notnull === 0,
      defaultValue: col.dflt_value || undefined,
      isAutoIncrement: col.pk === 1 && col.type.toUpperCase() === 'INTEGER',
    }));
  }

  private async getIndexes(tableName: string): Promise<IndexMetadata[]> {
    const result: IndexMetadata[] = [];

    // Get all indexes
    const indexes = this.db!.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>;

    for (const index of indexes) {
      const indexInfo = this.db!.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{
        seqno: number;
        cid: number;
        name: string;
      }>;

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
    const foreignKeys = this.db!.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
    }>;

    // Group by FK id
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

  async query(sql: string, params: any[] = [], timeoutMs?: number): Promise<QueryResult> {
    this.ensureConnected();

    const startTime = Date.now();
    try {
      if (timeoutMs) {
        this.db!.pragma(`busy_timeout = ${timeoutMs}`);
      }

      const stmt = this.db!.prepare(sql);
      const isSelect = sql.trim().toUpperCase().startsWith('SELECT');

      let rows: any[];
      let affectedRows = 0;

      if (isSelect) {
        rows = stmt.all(...params);
      } else {
        const result = stmt.run(...params);
        rows = [];
        affectedRows = result.changes;
      }

      const executionTimeMs = Date.now() - startTime;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

      return {
        rows,
        columns,
        rowCount: rows.length,
        executionTimeMs,
        affectedRows,
      };
    } catch (error) {
      this.handleError(error, 'query');
    }
  }

  async explain(sql: string, params: any[] = []): Promise<ExplainResult> {
    this.ensureConnected();

    try {
      const explainSql = `EXPLAIN QUERY PLAN ${sql}`;
      const stmt = this.db!.prepare(explainSql);
      const plan = stmt.all(...params);

      return {
        plan,
        formattedPlan: JSON.stringify(plan, null, 2),
      };
    } catch (error) {
      this.handleError(error, 'explain');
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      if (!this.db) return false;
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string> {
    this.ensureConnected();
    try {
      const result = this.db!.prepare('SELECT sqlite_version() as version').get() as {
        version: string;
      };
      return `SQLite ${result.version}`;
    } catch (error) {
      this.handleError(error, 'getVersion');
    }
  }
}
