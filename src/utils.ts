import crypto from 'crypto';
import { URL } from 'url';
import sqlParserPkg from 'node-sql-parser';
import { Relationship, DatabaseSchema, JoinPath, DatabaseType } from './types.js';

const { Parser } = sqlParserPkg;
const sqlParser = new Parser();

const SQL_DIALECTS: Partial<Record<DatabaseType, string>> = {
  mysql: 'MariaDB',
  postgres: 'Postgresql',
  sqlite: 'SQLite',
  mssql: 'TransactSQL',
};

const LIMIT_PUSHDOWN_DIALECTS: Partial<Record<DatabaseType, string>> = {
  mysql: SQL_DIALECTS.mysql,
  postgres: SQL_DIALECTS.postgres,
  sqlite: SQL_DIALECTS.sqlite,
};

const READ_ONLY_OPERATIONS = new Set([
  'SELECT',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'PRAGMA',
  'EXPLAIN',
]);

const WRITE_OPERATIONS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'REPLACE',
  'MERGE',
  'UPSERT',
  'CALL',
  'EXEC',
  'EXECUTE',
]);

export interface SqlSafetyAnalysis {
  normalizedSql: string;
  operation: string;
  isSingleStatement: boolean;
  isReadOnly: boolean;
  requiresWritePermissions: boolean;
  parseSucceeded: boolean;
}

type ParsedLimitNode =
  | {
      type: 'number';
      value: number | string;
    }
  | {
      type: string;
      value?: unknown;
    };

interface ParsedSelectAst {
  type?: string;
  limit?: {
    seperator?: string;
    value?: ParsedLimitNode[];
  } | null;
}

/**
 * Redact secrets from URLs and connection strings
 */
export function redactUrl(url: string): string {
  try {
    if (url.includes('://')) {
      const urlObj = new URL(url);
      if (urlObj.password) {
        urlObj.password = '***';
      }
      if (urlObj.username && urlObj.password) {
        return urlObj.toString();
      }
    }

    if (url.includes('Password=')) {
      return url.replace(/(Password=)[^;]+/gi, '$1***');
    }

    if (url.includes('/') && url.includes('@')) {
      return url.replace(/\/[^@]+@/, '/***@');
    }

    return url;
  } catch {
    return url.replace(/:\/\/[^@]*@/, '://***@');
  }
}

export function redactSensitiveText(value: string): string {
  if (!value) {
    return value;
  }

  let redacted = value.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s'",]+/gi,
    (match) => redactUrl(match)
  );

  redacted = redacted.replace(/(Password=)[^;,\s]+/gi, '$1***');
  redacted = redacted.replace(/(Pwd=)[^;,\s]+/gi, '$1***');
  redacted = redacted.replace(
    /\b([A-Za-z0-9_.-]+)\/([^@\s;]+)@([A-Za-z0-9_.-]+(?:[:/][^\s;]+)?)/g,
    '$1/***@$3'
  );

  return redacted;
}

/**
 * Interpolate environment variables in config values
 */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || '';
  });
}

function getParserDialect(dbType?: DatabaseType): string | undefined {
  return dbType ? SQL_DIALECTS[dbType] : undefined;
}

function sanitizeSqlForInspection(sql: string): string {
  let result = '';
  let i = 0;
  let mode:
    | 'normal'
    | 'single'
    | 'double'
    | 'backtick'
    | 'bracket'
    | 'line-comment'
    | 'block-comment' = 'normal';

  while (i < sql.length) {
    const current = sql[i];
    const next = sql[i + 1];

    if (mode === 'line-comment') {
      if (current === '\n') {
        result += '\n';
        mode = 'normal';
      }
      i++;
      continue;
    }

    if (mode === 'block-comment') {
      if (current === '*' && next === '/') {
        mode = 'normal';
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (mode === 'single') {
      if (current === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (current === "'") {
        mode = 'normal';
      }
      i++;
      continue;
    }

    if (mode === 'double') {
      if (current === '"' && next === '"') {
        i += 2;
        continue;
      }
      if (current === '"') {
        mode = 'normal';
      }
      i++;
      continue;
    }

    if (mode === 'backtick') {
      if (current === '`' && next === '`') {
        i += 2;
        continue;
      }
      if (current === '`') {
        mode = 'normal';
      }
      i++;
      continue;
    }

    if (mode === 'bracket') {
      if (current === ']' && next === ']') {
        i += 2;
        continue;
      }
      if (current === ']') {
        mode = 'normal';
      }
      i++;
      continue;
    }

    if (current === '-' && next === '-') {
      result += ' ';
      mode = 'line-comment';
      i += 2;
      continue;
    }

    if (current === '#') {
      result += ' ';
      mode = 'line-comment';
      i++;
      continue;
    }

    if (current === '/' && next === '*') {
      result += ' ';
      mode = 'block-comment';
      i += 2;
      continue;
    }

    if (current === "'") {
      result += ' ';
      mode = 'single';
      i++;
      continue;
    }

    if (current === '"') {
      result += ' ';
      mode = 'double';
      i++;
      continue;
    }

    if (current === '`') {
      result += ' ';
      mode = 'backtick';
      i++;
      continue;
    }

    if (current === '[') {
      result += ' ';
      mode = 'bracket';
      i++;
      continue;
    }

    result += current;
    i++;
  }

  return result;
}

function normalizeSqlForInspection(sql: string): string {
  return sanitizeSqlForInspection(sql).trim();
}

function hasInternalSemicolon(sql: string): boolean {
  const trimmed = sql.replace(/[;\s]+$/g, '');
  return trimmed.includes(';');
}

function getOperationFromAst(ast: any): string {
  if (!ast || typeof ast !== 'object' || typeof ast.type !== 'string') {
    return '';
  }

  return ast.type.toUpperCase();
}

function astContainsOperation(ast: unknown, operations: Set<string>): boolean {
  if (Array.isArray(ast)) {
    return ast.some((value) => astContainsOperation(value, operations));
  }

  if (!ast || typeof ast !== 'object') {
    return false;
  }

  const record = ast as Record<string, unknown>;
  if (typeof record.type === 'string' && operations.has(record.type.toUpperCase())) {
    return true;
  }

  return Object.values(record).some((value) => astContainsOperation(value, operations));
}

function parseSql(
  sql: string,
  dbType?: DatabaseType
): {
  ast?: any;
  parseSucceeded: boolean;
  isSingleStatement: boolean;
} {
  const dialect = getParserDialect(dbType);

  try {
    const ast = dialect
      ? sqlParser.astify(sql, { database: dialect })
      : sqlParser.astify(sql);

    if (Array.isArray(ast)) {
      return {
        parseSucceeded: true,
        isSingleStatement: ast.length === 1,
        ast: ast.length === 1 ? ast[0] : ast,
      };
    }

    return {
      ast,
      parseSucceeded: true,
      isSingleStatement: true,
    };
  } catch {
    return {
      parseSucceeded: false,
      isSingleStatement: !hasInternalSemicolon(normalizeSqlForInspection(sql)),
    };
  }
}

export function analyzeSqlSafety(sql: string, dbType?: DatabaseType): SqlSafetyAnalysis {
  const normalizedSql = normalizeSqlForInspection(sql);
  const parsed = parseSql(sql, dbType);

  if (parsed.parseSucceeded && parsed.ast && !Array.isArray(parsed.ast)) {
    const operation = getOperationFromAst(parsed.ast);
    const containsWrite = astContainsOperation(parsed.ast, WRITE_OPERATIONS);
    const isReadOnly = READ_ONLY_OPERATIONS.has(operation) && !containsWrite;

    return {
      normalizedSql,
      operation,
      isSingleStatement: parsed.isSingleStatement,
      isReadOnly,
      requiresWritePermissions: !isReadOnly,
      parseSucceeded: true,
    };
  }

  const operationMatch = normalizedSql.match(/^([a-zA-Z]+)/);
  const operation = operationMatch ? operationMatch[1].toUpperCase() : '';
  const containsWriteKeyword = Array.from(WRITE_OPERATIONS).some((candidate) =>
    new RegExp(`\\b${candidate}\\b`, 'i').test(normalizedSql)
  );
  const isReadOnly =
    parsed.isSingleStatement &&
    (operation === 'SELECT' || operation === 'WITH') &&
    !containsWriteKeyword;

  return {
    normalizedSql,
    operation,
    isSingleStatement: parsed.isSingleStatement,
    isReadOnly,
    requiresWritePermissions: !isReadOnly,
    parseSucceeded: parsed.parseSucceeded,
  };
}

/**
 * Generate a stable version/ETag from schema content
 */
export function generateSchemaVersion(schema: DatabaseSchema): string {
  const hash = crypto.createHash('sha256');

  const schemaData = {
    dbType: schema.dbType,
    schemas: schema.schemas.map((schemaEntry) => ({
      name: schemaEntry.name,
      tables: schemaEntry.tables
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((table) => ({
          name: table.name,
          type: table.type,
          columns: table.columns
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((column) => ({
              name: column.name,
              dataType: column.dataType,
              nullable: column.nullable,
            })),
          foreignKeys: table.foreignKeys.sort((a, b) => a.name.localeCompare(b.name)),
        })),
    })),
  };

  hash.update(JSON.stringify(schemaData));
  return hash.digest('hex').substring(0, 16);
}

/**
 * Infer relationships from column naming patterns
 */
export function inferRelationships(schema: DatabaseSchema): Relationship[] {
  const relationships: Relationship[] = [];

  const tableLookup = new Map<string, { schema: string; pk: string[] }>();

  for (const schemaObj of schema.schemas) {
    for (const table of schemaObj.tables) {
      const fullName = `${schemaObj.name}.${table.name}`;
      const pk = table.primaryKey?.columns || [];
      tableLookup.set(table.name.toLowerCase(), { schema: schemaObj.name, pk });
      tableLookup.set(fullName.toLowerCase(), { schema: schemaObj.name, pk });
    }
  }

  for (const schemaObj of schema.schemas) {
    for (const table of schemaObj.tables) {
      for (const column of table.columns) {
        const columnName = column.name.toLowerCase();
        const patterns = [/^(.+?)_id$/, /^(.+?)id$/i];

        for (const pattern of patterns) {
          const match = columnName.match(pattern);
          if (!match) {
            continue;
          }

          const referencedTableName = match[1].toLowerCase();
          const referencedTable = tableLookup.get(referencedTableName);

          if (referencedTable && referencedTable.pk.length > 0) {
            relationships.push({
              fromSchema: schemaObj.name,
              fromTable: table.name,
              fromColumns: [column.name],
              toSchema: referencedTable.schema,
              toTable: referencedTableName,
              toColumns: referencedTable.pk,
              type: 'inferred',
              confidence: 0.7,
            });
          }
        }
      }
    }
  }

  return relationships;
}

/**
 * Extract table names from SQL (best effort)
 */
export function extractTableNames(sql: string): string[] {
  const tables = new Set<string>();
  const patterns = [
    /(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi,
    /DELETE\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi,
  ];

  for (const pattern of patterns) {
    const matches = sql.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        tables.add(match[1].toLowerCase());
      }
    }
  }

  return Array.from(tables);
}

/**
 * Detect if SQL is a write operation
 */
export function isWriteOperation(sql: string, dbType?: DatabaseType): boolean {
  return analyzeSqlSafety(sql, dbType).requiresWritePermissions;
}

export function getSqlOperation(sql: string, dbType?: DatabaseType): string {
  return analyzeSqlSafety(sql, dbType).operation;
}

export function isReadOnlyQuery(sql: string, dbType?: DatabaseType): boolean {
  return analyzeSqlSafety(sql, dbType).isReadOnly;
}

export function pushDownResultLimit(
  sql: string,
  limit: number | undefined,
  dbType: DatabaseType,
  offset: number = 0
): { sql: string; applied: boolean } {
  if (
    limit === undefined ||
    !Number.isFinite(limit) ||
    limit < 0 ||
    !Number.isFinite(offset) ||
    offset < 0 ||
    !isReadOnlyQuery(sql, dbType)
  ) {
    return { sql, applied: false };
  }

  const dialect = LIMIT_PUSHDOWN_DIALECTS[dbType];
  if (!dialect) {
    return { sql, applied: false };
  }

  const normalizedLimit = Math.floor(limit);
  const normalizedOffset = Math.floor(offset);

  try {
    const ast = sqlParser.astify(sql, { database: dialect });
    if (Array.isArray(ast)) {
      return { sql, applied: false };
    }

    const selectAst = ast as ParsedSelectAst;
    if (selectAst.type !== 'select') {
      return { sql, applied: false };
    }

    const limitClause = selectAst.limit;
    if (!limitClause) {
      selectAst.limit = {
        seperator: normalizedOffset > 0 ? 'offset' : '',
        value:
          normalizedOffset > 0
            ? [
                { type: 'number', value: normalizedLimit },
                { type: 'number', value: normalizedOffset },
              ]
            : [{ type: 'number', value: normalizedLimit }],
      };

      return {
        sql: sqlParser.sqlify(selectAst as any, { database: dialect }),
        applied: true,
      };
    }

    const values = limitClause.value;
    if (!values || values.length === 0) {
      return { sql, applied: false };
    }

    if (normalizedOffset > 0) {
      return { sql, applied: false };
    }

    const targetIndex = limitClause.seperator === ',' ? 1 : 0;
    const targetNode = values[targetIndex];
    if (!targetNode || targetNode.type !== 'number') {
      return { sql, applied: false };
    }

    const currentLimit = Number(targetNode.value);
    if (!Number.isFinite(currentLimit) || currentLimit <= normalizedLimit) {
      return { sql, applied: false };
    }

    targetNode.value = normalizedLimit;

    return {
      sql: sqlParser.sqlify(selectAst as any, { database: dialect }),
      applied: true,
    };
  } catch {
    return { sql, applied: false };
  }
}

/**
 * Find join paths between tables using relationship graph
 */
export function findJoinPaths(
  tables: string[],
  relationships: Relationship[],
  maxDepth = 3
): JoinPath[] {
  if (tables.length < 2) {
    return [];
  }

  const graph = new Map<string, Relationship[]>();
  const nodeKeys = new Set<string>();

  for (const rel of relationships) {
    const fromKey = `${rel.fromSchema}.${rel.fromTable}`.toLowerCase();
    const toKey = `${rel.toSchema}.${rel.toTable}`.toLowerCase();

    nodeKeys.add(fromKey);
    nodeKeys.add(toKey);

    if (!graph.has(fromKey)) {
      graph.set(fromKey, []);
    }
    graph.get(fromKey)!.push(rel);

    const reverseRel: Relationship = {
      ...rel,
      fromSchema: rel.toSchema,
      fromTable: rel.toTable,
      fromColumns: rel.toColumns,
      toSchema: rel.fromSchema,
      toTable: rel.fromTable,
      toColumns: rel.fromColumns,
    };

    if (!graph.has(toKey)) {
      graph.set(toKey, []);
    }
    graph.get(toKey)!.push(reverseRel);
  }

  const resolveCandidates = (table: string): string[] => {
    const normalized = table.toLowerCase();
    if (nodeKeys.has(normalized)) {
      return [normalized];
    }

    return Array.from(nodeKeys).filter((key) => key.endsWith(`.${normalized}`));
  };

  const bfs = (
    starts: string[],
    ends: string[]
  ): { target: string; path: Relationship[] } | null => {
    const endSet = new Set(ends);
    const queue: Array<{ current: string; path: Relationship[] }> = starts.map((current) => ({
      current,
      path: [],
    }));
    const visited = new Set<string>(starts);

    while (queue.length > 0) {
      const { current, path } = queue.shift()!;

      if (path.length >= maxDepth) {
        continue;
      }

      for (const rel of graph.get(current) || []) {
        const next = `${rel.toSchema}.${rel.toTable}`.toLowerCase();
        const nextPath = [...path, rel];

        if (endSet.has(next)) {
          return { target: next, path: nextPath };
        }

        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ current: next, path: nextPath });
        }
      }
    }

    return null;
  };

  let currentCandidates = resolveCandidates(tables[0]);
  if (currentCandidates.length === 0) {
    return [];
  }

  const joinedTables = [currentCandidates[0]];
  const joins: JoinPath['joins'] = [];

  for (const table of tables.slice(1)) {
    const nextCandidates = resolveCandidates(table);
    if (nextCandidates.length === 0) {
      return [];
    }

    const segment = bfs(currentCandidates, nextCandidates);
    if (!segment) {
      return [];
    }

    for (const rel of segment.path) {
      const fromKey = `${rel.fromSchema}.${rel.fromTable}`.toLowerCase();
      const toKey = `${rel.toSchema}.${rel.toTable}`.toLowerCase();

      if (joinedTables[joinedTables.length - 1] !== fromKey) {
        joinedTables.push(fromKey);
      }
      joinedTables.push(toKey);

      joins.push({
        fromTable: rel.fromTable,
        toTable: rel.toTable,
        relationship: rel,
        joinCondition: rel.fromColumns
          .map((column, index) => {
            const targetColumn = rel.toColumns[index] || rel.toColumns[0];
            return `${rel.fromSchema}.${rel.fromTable}.${column} = ${rel.toSchema}.${rel.toTable}.${targetColumn}`;
          })
          .join(' AND '),
      });
    }

    currentCandidates = [segment.target];
  }

  return [
    {
      tables: joinedTables,
      joins,
    },
  ];
}

export function limitRows<T extends { rows: any[]; rowCount: number }>(
  result: T,
  limit?: number,
  offset: number = 0
): T {
  if ((limit === undefined || limit < 0) && offset <= 0) {
    return result;
  }

  const start = Math.max(0, offset);
  const end = limit === undefined || limit < 0 ? undefined : start + limit;
  const rows = result.rows.slice(start, end);
  return {
    ...result,
    rows,
    rowCount: rows.length,
  };
}

export function formatCsvValue(value: unknown): string {
  let normalized: string;

  if (value === null || value === undefined) {
    normalized = '';
  } else if (value instanceof Date) {
    normalized = value.toISOString();
  } else if (typeof value === 'object') {
    normalized = JSON.stringify(value);
  } else {
    normalized = String(value);
  }

  return /[",\n\r]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
}

export function serializeCsvRow(row: Record<string, unknown>, columns: string[]): string {
  return columns.map((column) => formatCsvValue(row[column])).join(',');
}

export function trimRowsBySerializedSize<T extends { rows: any[]; rowCount: number }>(
  result: T,
  maxBytes?: number
): {
  result: T;
  truncated: boolean;
  omittedRowCount: number;
  sizeBytes: number;
} {
  if (maxBytes === undefined || !Number.isFinite(maxBytes) || maxBytes < 0) {
    return {
      result,
      truncated: false,
      omittedRowCount: 0,
      sizeBytes: Buffer.byteLength(JSON.stringify(result.rows), 'utf8'),
    };
  }

  const normalizedMaxBytes = Math.floor(maxBytes);
  const measureRows = (rowCount: number) =>
    Buffer.byteLength(JSON.stringify(result.rows.slice(0, rowCount)), 'utf8');

  const fullSizeBytes = measureRows(result.rows.length);
  if (fullSizeBytes <= normalizedMaxBytes) {
    return {
      result,
      truncated: false,
      omittedRowCount: 0,
      sizeBytes: fullSizeBytes,
    };
  }

  let low = 0;
  let high = result.rows.length;
  let bestFit = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const sizeBytes = measureRows(mid);

    if (sizeBytes <= normalizedMaxBytes) {
      bestFit = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const rows = result.rows.slice(0, bestFit);

  return {
    result: {
      ...result,
      rows,
      rowCount: rows.length,
    },
    truncated: true,
    omittedRowCount: result.rows.length - rows.length,
    sizeBytes: measureRows(rows.length),
  };
}
