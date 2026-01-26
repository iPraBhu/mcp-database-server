import { z } from 'zod';

// Database types
export type DatabaseType = 'postgres' | 'mysql' | 'mssql' | 'sqlite' | 'oracle';

// Connection pool settings
export const ConnectionPoolSchema = z.object({
  min: z.number().min(0).optional(),
  max: z.number().min(1).optional(),
  idleTimeoutMillis: z.number().min(0).optional(),
  connectionTimeoutMillis: z.number().min(0).optional(),
});

export type ConnectionPool = z.infer<typeof ConnectionPoolSchema>;

// Introspection options
export const IntrospectionOptionsSchema = z.object({
  includeViews: z.boolean().optional().default(true),
  includeRoutines: z.boolean().optional().default(false),
  maxTables: z.number().min(1).optional(),
  excludeSchemas: z.array(z.string()).optional(),
  includeSchemas: z.array(z.string()).optional(),
});

export type IntrospectionOptions = z.infer<typeof IntrospectionOptionsSchema>;

// Database configuration
export const DatabaseConfigSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['postgres', 'mysql', 'mssql', 'sqlite', 'oracle']),
  url: z.string().optional(),
  path: z.string().optional(),
  readOnly: z.boolean().optional().default(true),
  pool: ConnectionPoolSchema.optional(),
  introspection: IntrospectionOptionsSchema.optional(),
  eagerConnect: z.boolean().optional().default(false),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

// Server configuration
export const ServerConfigSchema = z.object({
  databases: z.array(DatabaseConfigSchema).min(1),
  cache: z
    .object({
      directory: z.string().optional().default('.sql-mcp-cache'),
      ttlMinutes: z.number().min(0).optional().default(10),
    })
    .optional()
    .default({ directory: '.sql-mcp-cache', ttlMinutes: 10 }),
  security: z
    .object({
      allowWrite: z.boolean().optional().default(false),
      allowedWriteOperations: z.array(z.string()).optional(),
      disableDangerousOperations: z.boolean().optional().default(true),
      redactSecrets: z.boolean().optional().default(true),
    })
    .optional()
    .default({ allowWrite: false, disableDangerousOperations: true, redactSecrets: true }),
  logging: z
    .object({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional().default('info'),
      pretty: z.boolean().optional().default(false),
    })
    .optional()
    .default({ level: 'info', pretty: false }),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// Schema metadata types
export interface ColumnMetadata {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  isAutoIncrement?: boolean;
  comment?: string;
}

export interface IndexMetadata {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
}

export interface ForeignKeyMetadata {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface TableMetadata {
  schema: string;
  name: string;
  type: 'table' | 'view';
  columns: ColumnMetadata[];
  primaryKey?: IndexMetadata;
  indexes: IndexMetadata[];
  foreignKeys: ForeignKeyMetadata[];
  comment?: string;
}

export interface SchemaMetadata {
  name: string;
  tables: TableMetadata[];
}

export interface DatabaseSchema {
  dbId: string;
  dbType: DatabaseType;
  schemas: SchemaMetadata[];
  introspectedAt: Date;
  version: string; // ETag/version based on content
}

// Relationship types
export interface Relationship {
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
  type: 'foreign_key' | 'inferred';
  confidence?: number; // For inferred relationships
}

// Query result types
export interface QueryResult {
  rows: any[];
  columns: string[];
  rowCount: number;
  executionTimeMs: number;
  affectedRows?: number;
}

export interface ExplainResult {
  plan: any;
  formattedPlan?: string;
}

// Query tracking
export interface QueryHistoryEntry {
  timestamp: Date;
  sql: string;
  tables: string[];
  executionTimeMs: number;
  rowCount: number;
  error?: string;
}

// Join suggestion
export interface JoinPath {
  tables: string[];
  joins: Array<{
    fromTable: string;
    toTable: string;
    relationship: Relationship;
    joinCondition: string;
  }>;
}

// Database adapter interface
export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  introspect(options?: IntrospectionOptions): Promise<DatabaseSchema>;
  query(sql: string, params?: any[], timeoutMs?: number): Promise<QueryResult>;
  explain(sql: string, params?: any[]): Promise<ExplainResult>;
  testConnection(): Promise<boolean>;
  getVersion(): Promise<string>;
}

// Error types
export class DatabaseError extends Error {
  constructor(
    message: string,
    public code: string,
    public dbId?: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class ConfigError extends Error {
  constructor(message: string, public details?: any) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class CacheError extends Error {
  constructor(message: string, public originalError?: Error) {
    super(message);
    this.name = 'CacheError';
  }
}
