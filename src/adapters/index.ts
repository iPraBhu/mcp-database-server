import { DatabaseAdapter, DatabaseConfig } from '../types.js';
import { PostgresAdapter } from './postgres.js';
import { MySQLAdapter } from './mysql.js';
import { SQLiteAdapter } from './sqlite.js';
import { MSSQLAdapter } from './mssql.js';
import { OracleAdapter } from './oracle.js';

export function createAdapter(config: DatabaseConfig): DatabaseAdapter {
  switch (config.type) {
    case 'postgres':
      return new PostgresAdapter(config);
    case 'mysql':
      return new MySQLAdapter(config);
    case 'sqlite':
      return new SQLiteAdapter(config);
    case 'mssql':
      return new MSSQLAdapter(config);
    case 'oracle':
      return new OracleAdapter(config);
    default:
      throw new Error(`Unsupported database type: ${config.type}`);
  }
}

export { PostgresAdapter, MySQLAdapter, SQLiteAdapter, MSSQLAdapter, OracleAdapter };
