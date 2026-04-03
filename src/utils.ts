import crypto from 'crypto';
import { URL } from 'url';
import sqlParserPkg from 'node-sql-parser';
import { Relationship, DatabaseSchema, JoinPath, DatabaseType } from './types.js';

const { Parser } = sqlParserPkg;
const sqlParser = new Parser();

const LIMIT_PUSHDOWN_DIALECTS: Partial<Record<DatabaseType, string>> = {
  mysql: 'MariaDB',
  postgres: 'Postgresql',
  sqlite: 'SQLite',
};

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
    // Handle various URL formats
    if (url.includes('://')) {
      const urlObj = new URL(url);
      if (urlObj.password) {
        urlObj.password = '***';
      }
      if (urlObj.username && urlObj.password) {
        return urlObj.toString();
      }
    }
    
    // Handle SQL Server connection strings
    if (url.includes('Password=')) {
      return url.replace(/(Password=)[^;]+/gi, '$1***');
    }
    
    // Handle Oracle connection strings
    if (url.includes('/') && url.includes('@')) {
      return url.replace(/\/[^@]+@/, '/***@');
    }
    
    return url;
  } catch {
    // If parsing fails, be safe and redact everything after ://
    return url.replace(/:\/\/[^@]*@/, '://***@');
  }
}

/**
 * Interpolate environment variables in config values
 */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || '';
  });
}

/**
 * Generate a stable version/ETag from schema content
 */
export function generateSchemaVersion(schema: DatabaseSchema): string {
  const hash = crypto.createHash('sha256');
  
  // Create a stable representation of the schema
  const schemaData = {
    dbType: schema.dbType,
    schemas: schema.schemas.map((s) => ({
      name: s.name,
      tables: s.tables
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({
          name: t.name,
          type: t.type,
          columns: t.columns
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => ({
              name: c.name,
              dataType: c.dataType,
              nullable: c.nullable,
            })),
          foreignKeys: t.foreignKeys.sort((a, b) => a.name.localeCompare(b.name)),
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
  
  // Build a lookup of tables and their primary keys
  const tableLookup = new Map<string, { schema: string; pk: string[] }>();
  
  for (const schemaObj of schema.schemas) {
    for (const table of schemaObj.tables) {
      const fullName = `${schemaObj.name}.${table.name}`;
      const pk = table.primaryKey?.columns || [];
      tableLookup.set(table.name.toLowerCase(), { schema: schemaObj.name, pk });
      tableLookup.set(fullName.toLowerCase(), { schema: schemaObj.name, pk });
    }
  }
  
  // Look for FK patterns in each table
  for (const schemaObj of schema.schemas) {
    for (const table of schemaObj.tables) {
      for (const column of table.columns) {
        const columnName = column.name.toLowerCase();
        
        // Pattern 1: <table>_id or <table>Id
        const patterns = [
          /^(.+?)_id$/,
          /^(.+?)id$/i,
        ];
        
        for (const pattern of patterns) {
          const match = columnName.match(pattern);
          if (match) {
            const referencedTableName = match[1].toLowerCase();
            const referencedTable = tableLookup.get(referencedTableName);
            
            if (referencedTable && referencedTable.pk.length > 0) {
              // Only infer if we have a reasonable confidence
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
  }
  
  return relationships;
}

/**
 * Extract table names from SQL (best effort)
 */
export function extractTableNames(sql: string): string[] {
  const tables = new Set<string>();
  
  // Simple regex-based extraction (best effort)
  // Matches: FROM table, JOIN table, INTO table, UPDATE table, DELETE FROM table
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
export function isWriteOperation(sql: string): boolean {
  const upperSql = sql.trim().toUpperCase();
  const writeKeywords = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
    'REPLACE',
    'MERGE',
  ];
  
  for (const keyword of writeKeywords) {
    if (upperSql.startsWith(keyword)) {
      return true;
    }
  }
  
  return false;
}

export function getSqlOperation(sql: string): string {
  const normalizedSql = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .trim();

  const match = normalizedSql.match(/^([a-zA-Z]+)/);
  return match ? match[1].toUpperCase() : '';
}

export function isReadOnlyQuery(sql: string): boolean {
  const operation = getSqlOperation(sql);
  return operation === 'SELECT' || operation === 'WITH';
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
    !isReadOnlyQuery(sql)
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

  // Build adjacency list
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

    // Reverse direction
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

  const bfs = (starts: string[], ends: string[]): { target: string; path: Relationship[] } | null => {
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
