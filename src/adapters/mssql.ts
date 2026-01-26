import { Connection, Request } from 'tedious';
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

export class MSSQLAdapter extends BaseAdapter {
  private connection?: Connection;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Parse connection string
        const config = this.parseConnectionString(this.config.url!);

        this.connection = new Connection(config);

        this.connection.on('connect', (err) => {
          if (err) {
            reject(err);
          } else {
            this.connected = true;
            this.logger.info({ dbId: this.config.id }, 'SQL Server connected');
            resolve();
          }
        });

        this.connection.connect();
      } catch (error) {
        this.handleError(error, 'connect');
      }
    });
  }

  private parseConnectionString(connStr: string): any {
    const config: any = {
      options: {
        encrypt: true,
        trustServerCertificate: true,
        enableArithAbort: true,
      },
    };

    // Simple parser for SQL Server connection strings
    const parts = connStr.split(';').filter((p) => p.trim());
    for (const part of parts) {
      const [key, value] = part.split('=').map((s) => s.trim());
      const lowerKey = key.toLowerCase();

      if (lowerKey === 'server') {
        const [host, port] = value.split(',');
        config.server = host;
        if (port) config.options.port = parseInt(port);
      } else if (lowerKey === 'database') {
        config.options.database = value;
      } else if (lowerKey === 'user id') {
        config.authentication = {
          type: 'default',
          options: { userName: value, password: '' },
        };
      } else if (lowerKey === 'password') {
        if (config.authentication) {
          config.authentication.options.password = value;
        }
      } else if (lowerKey === 'encrypt') {
        config.options.encrypt = value.toLowerCase() === 'true';
      } else if (lowerKey === 'trustservercertificate') {
        config.options.trustServerCertificate = value.toLowerCase() === 'true';
      }
    }

    return config;
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      this.connection.close();
      this.connection = undefined;
      this.connected = false;
      this.logger.info({ dbId: this.config.id }, 'SQL Server disconnected');
    }
  }

  private executeQuery(sql: string, _params: any[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const rows: any[] = [];
      const request = new Request(sql, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });

      request.on('row', (columns) => {
        const row: any = {};
        columns.forEach((col: any) => {
          row[col.metadata.colName] = col.value;
        });
        rows.push(row);
      });

      this.connection!.execSql(request);
    });
  }

  async introspect(options?: IntrospectionOptions): Promise<DatabaseSchema> {
    this.ensureConnected();

    try {
      const schemas = await this.getSchemas(options);
      const dbSchema: DatabaseSchema = {
        dbId: this.config.id,
        dbType: 'mssql',
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

    const schemasQuery = `
      SELECT SCHEMA_NAME
      FROM INFORMATION_SCHEMA.SCHEMATA
      WHERE SCHEMA_NAME NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
      ORDER BY SCHEMA_NAME
    `;

    const schemasResult = await this.executeQuery(schemasQuery);
    let schemaNames = schemasResult.map((r) => r.SCHEMA_NAME);

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

    let tableTypes = "'BASE TABLE'";
    if (options?.includeViews) {
      tableTypes += ",'VIEW'";
    }

    const tablesQuery = `
      SELECT TABLE_NAME, TABLE_TYPE
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = '${schemaName}' AND TABLE_TYPE IN (${tableTypes})
      ORDER BY TABLE_NAME
      ${options?.maxTables ? `OFFSET 0 ROWS FETCH NEXT ${options.maxTables} ROWS ONLY` : ''}
    `;

    const tablesResult = await this.executeQuery(tablesQuery);

    for (const row of tablesResult) {
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
        COLUMNPROPERTY(OBJECT_ID(TABLE_SCHEMA + '.' + TABLE_NAME), COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${schemaName}' AND TABLE_NAME = '${tableName}'
      ORDER BY ORDINAL_POSITION
    `;

    const result = await this.executeQuery(query);

    return result.map((row) => ({
      name: row.COLUMN_NAME,
      dataType: row.DATA_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      maxLength: row.CHARACTER_MAXIMUM_LENGTH,
      precision: row.NUMERIC_PRECISION,
      scale: row.NUMERIC_SCALE,
      isAutoIncrement: row.IS_IDENTITY === 1,
    }));
  }

  private async getIndexes(schemaName: string, tableName: string): Promise<IndexMetadata[]> {
    const query = `
      SELECT
        i.name AS index_name,
        i.is_unique,
        i.is_primary_key,
        STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS column_names
      FROM sys.indexes i
      INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      INNER JOIN sys.tables t ON i.object_id = t.object_id
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = '${schemaName}' AND t.name = '${tableName}'
      GROUP BY i.name, i.is_unique, i.is_primary_key
    `;

    const result = await this.executeQuery(query);

    return result.map((row) => ({
      name: row.index_name,
      columns: row.column_names.split(','),
      isUnique: row.is_unique,
      isPrimary: row.is_primary_key,
    }));
  }

  private async getForeignKeys(
    schemaName: string,
    tableName: string
  ): Promise<ForeignKeyMetadata[]> {
    const query = `
      SELECT
        fk.name AS constraint_name,
        STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS column_names,
        rs.name AS referenced_schema,
        rt.name AS referenced_table,
        STRING_AGG(rc.name, ',') WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS referenced_columns,
        fk.update_referential_action_desc,
        fk.delete_referential_action_desc
      FROM sys.foreign_keys fk
      INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      INNER JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
      INNER JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
      INNER JOIN sys.tables t ON fk.parent_object_id = t.object_id
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      INNER JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
      INNER JOIN sys.schemas rs ON rt.schema_id = rs.schema_id
      WHERE s.name = '${schemaName}' AND t.name = '${tableName}'
      GROUP BY fk.name, rs.name, rt.name, fk.update_referential_action_desc, fk.delete_referential_action_desc
    `;

    const result = await this.executeQuery(query);

    return result.map((row) => ({
      name: row.constraint_name,
      columns: row.column_names.split(','),
      referencedSchema: row.referenced_schema,
      referencedTable: row.referenced_table,
      referencedColumns: row.referenced_columns.split(','),
      onUpdate: row.update_referential_action_desc,
      onDelete: row.delete_referential_action_desc,
    }));
  }

  async query(sql: string, params: any[] = [], _timeoutMs?: number): Promise<QueryResult> {
    this.ensureConnected();

    const startTime = Date.now();
    try {
      const rows = await this.executeQuery(sql, params);
      const executionTimeMs = Date.now() - startTime;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

      return {
        rows,
        columns,
        rowCount: rows.length,
        executionTimeMs,
      };
    } catch (error) {
      this.handleError(error, 'query');
    }
  }

  async explain(sql: string, params: any[] = []): Promise<ExplainResult> {
    this.ensureConnected();

    try {
      const explainSql = `SET SHOWPLAN_TEXT ON; ${sql}; SET SHOWPLAN_TEXT OFF;`;
      const plan = await this.executeQuery(explainSql, params);

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
      if (!this.connection) return false;
      await this.executeQuery('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string> {
    this.ensureConnected();
    try {
      const result = await this.executeQuery('SELECT @@VERSION as version');
      return result[0].version;
    } catch (error) {
      this.handleError(error, 'getVersion');
    }
  }
}
