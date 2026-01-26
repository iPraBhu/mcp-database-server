# SQL MCP Server

A comprehensive Model Context Protocol (MCP) server that provides unified access to multiple SQL databases with automatic schema caching, relationship discovery, and intelligent query assistance.

## Features

- 🗄️ **Multi-Database Support**: PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Oracle (stub)
- 🔍 **Automatic Schema Introspection**: Discovers tables, columns, indexes, foreign keys, and relationships
- 💾 **Intelligent Caching**: Persistent schema cache with TTL and automatic invalidation
- 🔗 **Relationship Discovery**: Automatic foreign key detection and heuristic relationship inference
- 📊 **Query Tracking**: Maintains query history and execution statistics
- 🎯 **Join Suggestions**: Intelligent join path recommendations based on relationship graph
- 🔒 **Security**: Read-only mode, write operation controls, secret redaction
- ⚡ **Performance**: Connection pooling, query timeouts, concurrent introspection protection

## Supported Databases

| Database | Driver | Status | Notes |
|----------|--------|--------|-------|
| PostgreSQL | `pg` | ✅ Full Support | Includes CockroachDB compatibility |
| MySQL/MariaDB | `mysql2` | ✅ Full Support | Includes Amazon Aurora MySQL compatibility |
| SQLite | `better-sqlite3` | ✅ Full Support | File-based databases |
| SQL Server | `tedious` | ✅ Full Support | Microsoft SQL Server / Azure SQL |
| Oracle | `oracledb` | ⚠️ Stub | Requires Oracle Instant Client |

## Installation

```bash
npm install
npm run build
```

## Configuration

Create a `sql-mcp.config.json` file:

```json
{
  "databases": [
    {
      "id": "postgres-main",
      "type": "postgres",
      "url": "${DB_URL_POSTGRES}",
      "readOnly": false,
      "pool": {
        "min": 2,
        "max": 10,
        "idleTimeoutMillis": 30000
      },
      "introspection": {
        "includeViews": true,
        "excludeSchemas": ["pg_catalog"]
      }
    },
    {
      "id": "sqlite-local",
      "type": "sqlite",
      "path": "./data/app.db"
    }
  ],
  "cache": {
    "directory": ".sql-mcp-cache",
    "ttlMinutes": 10
  },
  "security": {
    "allowWrite": false,
    "allowedWriteOperations": ["INSERT", "UPDATE"],
    "redactSecrets": true
  },
  "logging": {
    "level": "info",
    "pretty": false
  }
}
```

### Configuration Options

#### Database Configuration

- **`id`** (required): Unique identifier for the database
- **`type`** (required): Database type (`postgres`, `mysql`, `sqlite`, `mssql`, `oracle`)
- **`url`**: Connection URL (required for all except SQLite)
- **`path`**: File path (SQLite only)
- **`readOnly`**: Enable read-only mode (default: `false`)
- **`pool`**: Connection pool settings
  - `min`: Minimum connections
  - `max`: Maximum connections
  - `idleTimeoutMillis`: Idle timeout
  - `connectionTimeoutMillis`: Connection timeout
- **`introspection`**: Schema introspection options
  - `includeViews`: Include views (default: `true`)
  - `includeRoutines`: Include stored procedures/functions
  - `maxTables`: Limit number of tables to introspect
  - `includeSchemas`: Array of schemas to include
  - `excludeSchemas`: Array of schemas to exclude
- **`eagerConnect`**: Connect on startup (default: `false`)

#### Cache Configuration

- **`directory`**: Cache directory path (default: `.sql-mcp-cache`)
- **`ttlMinutes`**: Cache TTL in minutes (default: `10`)

#### Security Configuration

- **`allowWrite`**: Allow write operations globally (default: `false`)
- **`allowedWriteOperations`**: Whitelist of allowed write operations (e.g., `["INSERT", "UPDATE"]`)
- **`redactSecrets`**: Redact passwords in logs (default: `true`)

#### Logging Configuration

- **`level`**: Log level (`trace`, `debug`, `info`, `warn`, `error`)
- **`pretty`**: Pretty-print logs (default: `false`)

### Environment Variables

Use environment variable interpolation in config:

```json
{
  "url": "${DB_URL_POSTGRES}"
}
```

Create a `.env` file:

```env
DB_URL_POSTGRES=postgresql://user:password@localhost:5432/dbname
DB_URL_MYSQL=mysql://user:password@localhost:3306/dbname
```

### Connection Strings

**PostgreSQL:**
```
postgresql://user:password@host:5432/database
```

**MySQL:**
```
mysql://user:password@host:3306/database
```

**SQL Server:**
```
Server=host,1433;Database=dbname;User Id=sa;Password=pass;Encrypt=true
```

**SQLite:**
```json
{
  "type": "sqlite",
  "path": "./data/app.db"
}
```

**Oracle:**
```
user/password@host:1521/XEPDB1
```

## MCP Client Configuration

Add to your MCP client's `mcp.json`:

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "node",
      "args": [
        "/path/to/sql-mcp/dist/index.js",
        "--config",
        "/path/to/sql-mcp.config.json"
      ],
      "env": {
        "DB_URL_POSTGRES": "postgresql://user:password@localhost:5432/dbname"
      }
    }
  }
}
```

## Available Tools

### `list_databases`

List all configured databases with connection status and cache information.

**Input:** None

**Output:**
```json
[
  {
    "id": "postgres-main",
    "type": "postgres",
    "connected": true,
    "cached": true,
    "cacheAge": 45000,
    "version": "abc123"
  }
]
```

### `introspect_schema`

Introspect and cache database schema metadata.

**Input:**
```json
{
  "dbId": "postgres-main",
  "forceRefresh": false,
  "schemaFilter": {
    "includeSchemas": ["public"],
    "excludeSchemas": ["temp"],
    "includeViews": true,
    "maxTables": 100
  }
}
```

**Output:**
```json
{
  "dbId": "postgres-main",
  "version": "abc123",
  "introspectedAt": "2026-01-26T10:00:00.000Z",
  "schemas": [
    {
      "name": "public",
      "tableCount": 15,
      "viewCount": 3
    }
  ],
  "totalTables": 15,
  "totalRelationships": 12
}
```

### `get_schema`

Retrieve cached schema metadata.

**Input:**
```json
{
  "dbId": "postgres-main",
  "schema": "public",
  "table": "users"
}
```

**Output:** Complete schema metadata including tables, columns, indexes, and foreign keys.

### `run_query`

Execute SQL query with automatic schema caching and relationship annotation.

**Input:**
```json
{
  "dbId": "postgres-main",
  "sql": "SELECT * FROM users WHERE active = $1",
  "params": [true],
  "limit": 100,
  "timeoutMs": 5000
}
```

**Output:**
```json
{
  "rows": [...],
  "columns": ["id", "name", "email", "active"],
  "rowCount": 42,
  "executionTimeMs": 15,
  "metadata": {
    "relationships": [...],
    "queryStats": {
      "totalQueries": 10,
      "avgExecutionTime": 20,
      "errorCount": 0
    }
  }
}
```

**Security:**
- Write operations blocked by default unless `allowWrite: true`
- Specific operations can be whitelisted via `allowedWriteOperations`

### `explain_query`

Get database query execution plan.

**Input:**
```json
{
  "dbId": "postgres-main",
  "sql": "SELECT * FROM users JOIN orders ON users.id = orders.user_id",
  "params": []
}
```

**Output:** Database-native execution plan (JSON format where supported).

### `suggest_joins`

Get intelligent join suggestions based on relationship graph.

**Input:**
```json
{
  "dbId": "postgres-main",
  "tables": ["users", "orders", "products"]
}
```

**Output:**
```json
[
  {
    "tables": ["users", "orders", "products"],
    "joins": [
      {
        "fromTable": "users",
        "toTable": "orders",
        "relationship": {...},
        "joinCondition": "users.id = orders.user_id"
      },
      {
        "fromTable": "orders",
        "toTable": "products",
        "relationship": {...},
        "joinCondition": "orders.product_id = products.id"
      }
    ]
  }
]
```

### `clear_cache`

Clear schema cache and query history.

**Input:**
```json
{
  "dbId": "postgres-main"
}
```

Omit `dbId` to clear all caches.

### `cache_status`

Get cache status and statistics.

**Input:**
```json
{
  "dbId": "postgres-main"
}
```

**Output:**
```json
[
  {
    "dbId": "postgres-main",
    "exists": true,
    "age": 45000,
    "ttlMinutes": 10,
    "expired": false,
    "version": "abc123",
    "tableCount": 15,
    "relationshipCount": 12
  }
]
```

### `health_check`

Check database connectivity and version information.

**Input:**
```json
{
  "dbId": "postgres-main"
}
```

**Output:**
```json
[
  {
    "dbId": "postgres-main",
    "healthy": true,
    "version": "PostgreSQL 15.3"
  }
]
```

## Resources

The server exposes cached schemas as MCP resources:

- **URI:** `schema://{dbId}`
- **MIME Type:** `application/json`
- **Content:** Complete cached schema metadata

## Schema Introspection

### Automatic Discovery

The server automatically discovers:

1. **Tables and Views**: All user tables and optionally views
2. **Columns**: Name, data type, nullability, defaults, auto-increment
3. **Indexes**: Including primary keys and unique constraints
4. **Foreign Keys**: Explicit relationship metadata
5. **Relationships**: Both explicit and inferred

### Relationship Inference

When foreign keys are not defined, the server infers relationships using heuristics:

- Column names matching `{table}_id` or `{table}Id`
- Data type compatibility with target primary key
- Confidence scoring for inferred relationships

### Caching Strategy

- **Memory + Disk**: Dual-layer caching for performance
- **TTL-based**: Configurable time-to-live
- **Version Tracking**: Content-based versioning (hash)
- **Concurrency Safe**: Prevents duplicate introspection
- **On-Demand Refresh**: Manual or automatic refresh

## Query Tracking

The server maintains per-database query history:

- Timestamp and SQL text
- Execution time and row count
- Referenced tables (best-effort extraction)
- Error tracking
- Aggregate statistics

Use this data to:
- Monitor query performance
- Identify frequently accessed tables
- Detect query patterns
- Debug issues

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint
npm run lint

# Format code
npm run format

# Type check
npm run typecheck
```

## Project Structure

```
src/
├── adapters/          # Database adapters
│   ├── base.ts        # Base adapter class
│   ├── postgres.ts    # PostgreSQL adapter
│   ├── mysql.ts       # MySQL adapter
│   ├── sqlite.ts      # SQLite adapter
│   ├── mssql.ts       # SQL Server adapter
│   ├── oracle.ts      # Oracle adapter (stub)
│   └── index.ts       # Adapter factory
├── cache.ts           # Schema caching
├── config.ts          # Configuration loader
├── database-manager.ts # Database orchestration
├── logger.ts          # Logging setup
├── mcp-server.ts      # MCP server implementation
├── query-tracker.ts   # Query history tracking
├── types.ts           # TypeScript types
├── utils.ts           # Utility functions
└── index.ts           # Entry point
```

## Adding New Database Adapters

1. Implement the `DatabaseAdapter` interface in `src/adapters/`
2. Follow the pattern from existing adapters
3. Add to adapter factory in `src/adapters/index.ts`
4. Update type definitions if needed
5. Add tests

Example:

```typescript
import { BaseAdapter } from './base.js';

export class CustomAdapter extends BaseAdapter {
  async connect(): Promise<void> { /* ... */ }
  async disconnect(): Promise<void> { /* ... */ }
  async introspect(): Promise<DatabaseSchema> { /* ... */ }
  async query(): Promise<QueryResult> { /* ... */ }
  async explain(): Promise<ExplainResult> { /* ... */ }
  async testConnection(): Promise<boolean> { /* ... */ }
  async getVersion(): Promise<string> { /* ... */ }
}
```

## Troubleshooting

### Connection Issues

- Verify connection strings and credentials
- Check network connectivity and firewall rules
- Enable debug logging: `"logging": { "level": "debug" }`
- Use `health_check` tool to test connectivity

### Cache Issues

- Clear cache: Use `clear_cache` tool
- Check cache directory permissions
- Verify TTL settings
- Review cache status with `cache_status` tool

### Performance

- Adjust connection pool settings
- Use `maxTables` to limit introspection scope
- Set appropriate cache TTL
- Enable read-only mode when possible

### Oracle Setup

The Oracle adapter requires additional setup:

1. Install Oracle Instant Client
2. Set environment variables (`LD_LIBRARY_PATH` or `PATH`)
3. Install `oracledb` package
4. Implement stub methods in `src/adapters/oracle.ts`

## Security Considerations

- Always use read-only mode in production unless write access is required
- Use environment variables for credentials, never hardcode
- Enable secret redaction in logs
- Restrict write operations with `allowedWriteOperations`
- Use connection string encryption where supported
- Regular security audits of configurations

## License

MIT

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## Support

For issues, questions, or feature requests, please open an issue on GitHub.