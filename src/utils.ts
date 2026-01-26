import crypto from 'crypto';
import { Relationship, DatabaseSchema } from './types.js';

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

/**
 * Find join paths between tables using relationship graph
 */
export function findJoinPaths(
  tables: string[],
  relationships: Relationship[],
  maxDepth = 3
): any[] {
  if (tables.length < 2) {
    return [];
  }
  
  const paths: any[] = [];
  
  // Build adjacency list
  const graph = new Map<string, Relationship[]>();
  for (const rel of relationships) {
    const fromKey = `${rel.fromSchema}.${rel.fromTable}`.toLowerCase();
    const toKey = `${rel.toSchema}.${rel.toTable}`.toLowerCase();
    
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
  
  // Simple BFS to find shortest path between first two tables
  const start = tables[0].toLowerCase();
  const end = tables[1].toLowerCase();
  
  const queue: Array<{ current: string; path: Relationship[] }> = [{ current: start, path: [] }];
  const visited = new Set<string>([start]);
  
  while (queue.length > 0) {
    const { current, path } = queue.shift()!;
    
    if (path.length >= maxDepth) {
      continue;
    }
    
    const neighbors = graph.get(current) || [];
    for (const rel of neighbors) {
      const next = `${rel.toSchema}.${rel.toTable}`.toLowerCase();
      
      if (next === end) {
        paths.push({
          tables: [start, ...path.map((r) => `${r.toSchema}.${r.toTable}`), end],
          joins: [...path, rel],
        });
        continue;
      }
      
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ current: next, path: [...path, rel] });
      }
    }
  }
  
  return paths;
}
