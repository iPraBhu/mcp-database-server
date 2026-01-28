# AI Coding Agent Instructions for mcp-database-server

## Project Overview
This is a production-grade Model Context Protocol (MCP) server providing unified access to multiple SQL databases. It enables AI assistants to safely query, introspect, and analyze database schemas across PostgreSQL, MySQL, SQLite, SQL Server, and Oracle databases.

## Architecture & Key Components

### Core Architecture
- **MCP Server Layer** (`src/mcp-server.ts`): Handles JSON-RPC over stdio, exposes 14+ MCP tools
- **Database Manager** (`src/database-manager.ts`): Central orchestration, connection management, security enforcement
- **Schema Cache** (`src/cache.ts`): Dual-layer (memory + disk) caching with TTL and SHA-256 versioning
- **Query Tracker** (`src/query-tracker.ts`): History, statistics, and table reference extraction
- **Adapter Pattern**: Abstract `BaseAdapter` with concrete implementations in `src/adapters/`

### Data Flow Patterns
1. **Schema Introspection**: `introspect_schema` → Database Manager → Adapter → Cache (memory + disk)
2. **Query Execution**: `run_query` → Security checks → Adapter query → Track in QueryTracker → Annotate relationships
3. **Join Suggestions**: Graph-based BFS traversal of discovered relationships

## Critical Developer Workflows

### Configuration Discovery
- Config file auto-discovery: Searches for `.mcp-database-server.config` from project root (detected via `package.json`, `.git`) upward
- Environment variable interpolation: `"url": "${DB_URL_POSTGRES}"`
- Validation via Zod schemas in `src/types.ts`

### Build & Development
```bash
npm run build          # tsup bundler → ESM output in dist/
npm run dev           # Watch mode compilation
npm run test          # vitest with coverage
npm run lint          # ESLint (max 100 warnings)
npm run typecheck     # TypeScript strict checking
```

### Database Adapter Implementation
When adding new database support:
1. Extend `BaseAdapter` in `src/adapters/`
2. Implement required abstract methods: `connect()`, `introspect()`, `query()`, `explain()`
3. Add to `src/adapters/index.ts` factory
4. Update `DatabaseType` union in `src/types.ts`

## Project-Specific Patterns & Conventions

### Error Handling
- Custom `DatabaseError` class with operation context and database ID
- `handleError()` method in BaseAdapter for consistent logging and wrapping
- All async operations use try/catch with `this.handleError(error, 'operationName')`

### Schema Introspection
- Normalized `DatabaseSchema` structure across all adapters
- Foreign key detection + heuristic inference (pattern matching: `{table}_id`, `{table}Id`)
- Relationship confidence scoring and deduplication

### Security Controls
- Read-only mode enforcement at query execution
- Write operation whitelisting: `["INSERT", "UPDATE"]`
- Secret redaction in logs/outputs using `redactUrl()` from `src/utils.ts`

### Logging
- Pino-based structured logging with configurable levels
- Context enrichment: `{ dbId, operation, error }`
- Pretty printing toggle for development

### Configuration Validation
- Zod schemas for all config objects (see `src/types.ts`)
- Friendly error messages with `ConfigError` class
- Post-validation business logic checks (e.g., URL vs path validation)

## Key Files & Their Roles

- `src/index.ts`: CLI entry point, config loading, graceful shutdown
- `src/mcp-server.ts`: MCP tool definitions and request handlers (14 tools)
- `src/database-manager.ts`: Business logic orchestration
- `src/cache.ts`: Schema caching with TTL/versioning
- `src/adapters/base.ts`: Abstract adapter interface
- `src/adapters/postgres.ts`: PostgreSQL implementation example
- `src/types.ts`: Zod schemas and TypeScript interfaces
- `src/utils.ts`: Environment interpolation, URL redaction, schema versioning

## Common Implementation Patterns

### Adapter Query Execution
```typescript
async query(sql: string, params?: any[], timeoutMs?: number): Promise<QueryResult> {
  this.ensureConnected();
  try {
    // Database-specific execution
    const result = await this.pool.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  } catch (error) {
    this.handleError(error, 'query');
  }
}
```

### Schema Introspection Structure
```typescript
const dbSchema: DatabaseSchema = {
  dbId: this._config.id,
  dbType: 'postgres',
  schemas: [...],
  introspectedAt: new Date(),
  version: generateSchemaVersion(dbSchema)  // SHA-256 hash
};
```

### MCP Tool Handler Pattern
```typescript
this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case 'run_query':
      return await this.handleRunQuery(args);
    // ... other tools
  }
});
```

## Testing Approach
- Unit tests for utilities (`src/utils.test.ts`, `src/cache.test.ts`)
- Vitest framework with coverage reporting
- Mock database connections for adapter testing
- Focus on schema parsing, relationship inference, and configuration validation

## Deployment & Integration
- NPM package with binary: `mcp-database-server --config path/to/config.json`
- MCP client integration (Claude Desktop, IDEs) via stdio JSON-RPC
- Graceful shutdown handling (SIGINT/SIGTERM)
- Connection pooling with configurable limits per database