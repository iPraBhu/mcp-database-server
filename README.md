# MCP Database Server

> **Enterprise-grade Model Context Protocol server for unified SQL database access**

A production-ready MCP server that provides seamless, intelligent access to multiple SQL databases with automatic schema discovery, relationship mapping, and built-in security controls.

## Features

- 🗄️ **Multi-Database Support** - PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Oracle
- 🔍 **Automatic Schema Discovery** - Tables, columns, indexes, foreign keys, and relationships
- 💾 **Intelligent Caching** - Persistent schema cache with TTL and version management
- 🔗 **Relationship Inference** - Automatic foreign key detection plus heuristic pattern matching
- 📊 **Query Intelligence** - Execution tracking, statistics, and performance insights
- 🎯 **Join Assistance** - Smart join path recommendations based on relationship graphs
- 🔒 **Enterprise Security** - Read-only mode, operation controls, dangerous operation protection, secret redaction
- ⚡ **High Performance** - Connection pooling, query timeouts, concurrent operation protection
- 🌐 **Environment Flexibility** - Environment variable interpolation for secure configuration

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Client                            │
│            (Claude Desktop, IDEs, etc.)                  │
└────────────────┬────────────────────────────────────────┘
                 │ JSON-RPC over stdio
┌────────────────▼────────────────────────────────────────┐
│                MCP Database Server                       │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Schema Cache (TTL + Versioning)        │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Query Tracker (History + Statistics)            │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Security Layer (Read-only, Operation Controls)  │   │
│  └──────────────────────────────────────────────────┘   │
└────┬─────────┬─────────┬──────────┬──────────┬─────────┘
     │         │         │          │          │
┌────▼───┐ ┌──▼────┐ ┌──▼─────┐ ┌──▼──────┐ ┌▼────────┐
│Postgres│ │ MySQL │ │ SQLite │ │ MSSQL   │ │ Oracle  │
└────────┘ └───────┘ └────────┘ └─────────┘ └─────────┘
```

## Supported Databases

| Database | Driver | Status | Notes |
|----------|--------|--------|-------|
| PostgreSQL | `pg` | ✅ Full Support | Includes CockroachDB compatibility |
| MySQL/MariaDB | `mysql2` | ✅ Full Support | Includes Amazon Aurora MySQL compatibility |
| SQLite | `better-sqlite3` | ✅ Full Support | File-based databases |
| SQL Server | `tedious` | ✅ Full Support | Microsoft SQL Server / Azure SQL |
| Oracle | `oracledb` | ⚠️ Stub | Requires Oracle Instant Client |

## Installation

### Method 1: Install from npm (Recommended)

If this package is published to npm:

```bash
npm install -g mcp-database-server
```

Then you can run it directly:

```bash
mcp-database-server --config /path/to/your/config.json
```

### Method 2: Install from source

Clone and build the project:

```bash
git clone https://github.com/iPraBhu/mcp-database-server.git
cd mcp-database-server
npm install
npm run build
```

Then run it:

```bash
node dist/index.js --config ./.mcp-database-server.config
```

## Configuration

Create a `.mcp-database-server.config` file in your project root:

> **Note:** The config file is automatically discovered! If you don't specify `--config`, the tool searches for `.mcp-database-server.config` starting in the current directory and traversing up parent directories until found. This means you can run the tool from any subdirectory of your project.

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
    "disableDangerousOperations": true,
    "redactSecrets": true
  },
  "logging": {
    "level": "info",
    "pretty": false
  }
}
```

### Configuration Reference

#### Database Configuration

Each database in the `databases` array represents a connection to a SQL database.

##### Core Properties

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `id` | string | ✅ Yes | - | Unique identifier for this database connection. Used in all MCP tool calls. Must be unique across all databases. |
| `type` | enum | ✅ Yes | - | Database system type. Valid values: `postgres`, `mysql`, `sqlite`, `mssql`, `oracle` |
| `url` | string | Conditional* | - | Database connection string. Required for all databases except SQLite. Supports environment variable interpolation: `${DB_URL}` |
| `path` | string | Conditional** | - | Filesystem path to SQLite database file. Required only for `type: sqlite`. Can be relative or absolute. |
| `readOnly` | boolean | No | `true` | When `true`, blocks all write operations (INSERT, UPDATE, DELETE, etc.). Recommended for production safety. |
| `eagerConnect` | boolean | No | `false` | When `true`, connects to database immediately at startup (fail-fast). When `false`, connects on first query (lazy loading). |

<sub>* Required for postgres, mysql, mssql, oracle</sub>  
<sub>** Required for sqlite only</sub>

**Connection String Formats:**
```
PostgreSQL:  postgresql://username:password@host:5432/database
MySQL:       mysql://username:password@host:3306/database  
SQL Server:  Server=host,1433;Database=dbname;User Id=user;Password=pass
SQLite:      (use path property instead)
Oracle:      username/password@host:1521/servicename
```

##### Connection Pool Configuration

The `pool` object controls connection pooling behavior. Improves performance by reusing database connections.

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `min` | number | No | `2` | Minimum number of connections to maintain in the pool. Kept alive even when idle. |
| `max` | number | No | `10` | Maximum number of concurrent connections. Do not exceed your database's connection limit. |
| `idleTimeoutMillis` | number | No | `30000` | Time (ms) to keep idle connections alive before closing. Example: `60000` = 1 minute. |
| `connectionTimeoutMillis` | number | No | `10000` | Time (ms) to wait when establishing a connection before timing out. Fail-fast if database is unreachable. |

**Recommendations:**
- **Development:** `min: 1`, `max: 5`
- **Production (Low Traffic):** `min: 2`, `max: 10`
- **Production (High Traffic):** `min: 5`, `max: 20`

##### Introspection Configuration

The `introspection` object controls schema discovery behavior. Determines what database objects are analyzed.

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `includeViews` | boolean | No | `true` | Include database views in schema discovery. Set to `false` if views cause performance issues. |
| `includeRoutines` | boolean | No | `false` | Include stored procedures and functions. (Not fully implemented - planned feature) |
| `maxTables` | number | No | unlimited | Limit introspection to first N tables. Useful for databases with 1000+ tables. May result in incomplete relationship discovery. |
| `includeSchemas` | string[] | No | all | Whitelist of schemas to introspect. Only applicable to PostgreSQL and SQL Server. Example: `["public", "app"]` |
| `excludeSchemas` | string[] | No | none | Blacklist of schemas to skip. Common values: `["pg_catalog", "information_schema", "sys"]` |

**Schema vs Database:**
- **PostgreSQL/SQL Server:** Support multiple schemas per database. Use `includeSchemas`/`excludeSchemas`.
- **MySQL/MariaDB:** Schema = database. Use database name in connection string.
- **SQLite:** Single-file database, no schema concept.

#### Cache Configuration

Controls schema metadata caching to improve startup performance and reduce database load.

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `directory` | string | No | `.sql-mcp-cache` | Directory path where cached schema files are stored. One JSON file per database. |
| `ttlMinutes` | number | No | `10` | Time-To-Live in minutes. How long cached schema is considered valid before automatic refresh. |

**Cache Behavior:**
- **On Startup:** Loads schema from cache if available and not expired
- **After TTL Expiry:** Next query triggers automatic re-introspection
- **Manual Refresh:** Use `clear_cache` tool or `introspect_schema` with `forceRefresh: true`
- **Cache Files:** Stored as `{database-id}.json` (e.g., `postgres-main.json`)

**Recommended TTL Values:**
- **Development:** `5` minutes (schema changes frequently)
- **Staging:** `30-60` minutes
- **Production (Static):** `1440` minutes (24 hours)
- **Production (Active):** `60-240` minutes (1-4 hours)

#### Security Configuration

Comprehensive security controls to protect your databases from unauthorized or dangerous operations.

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `allowWrite` | boolean | No | `false` | Master switch for write operations. When `false`, all writes are blocked across all databases. |
| `allowedWriteOperations` | string[] | No | all | Whitelist of allowed SQL operations when `allowWrite: true`. Valid values: `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `REPLACE`, `MERGE` |
| `disableDangerousOperations` | boolean | No | `true` | **Extra safety layer.** When `true`, blocks `DELETE`, `TRUNCATE`, and `DROP` operations even if writes are allowed. Prevents accidental data loss. |
| `redactSecrets` | boolean | No | `true` | Automatically redact passwords and credentials in logs and error messages. |

**Security Layers (Evaluated in Order):**

1. **Database-level `readOnly`** → Blocks all writes for specific database
2. **Global `allowWrite`** → Master switch for all databases
3. **`disableDangerousOperations`** → Blocks DELETE/TRUNCATE/DROP specifically
4. **`allowedWriteOperations`** → Whitelist of permitted operations

**Example Configurations:**

```json
// Read-only access (default - safest)
{
  "allowWrite": false
}

// Allow INSERT and UPDATE only (no deletes)
{
  "allowWrite": true,
  "allowedWriteOperations": ["INSERT", "UPDATE"],
  "disableDangerousOperations": true
}

// Full write access (development only - dangerous!)
{
  "allowWrite": true,
  "disableDangerousOperations": false
}
```

#### Logging Configuration

Controls log output verbosity and formatting.

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `level` | enum | No | `info` | Log level. Valid values: `trace`, `debug`, `info`, `warn`, `error`. Lower levels include higher levels. |
| `pretty` | boolean | No | `false` | When `true`, formats logs as human-readable text. When `false`, outputs structured JSON (better for production log aggregation). |

**Log Levels:**
- **`trace`:** Everything (extremely verbose - use for debugging only)
- **`debug`:** Detailed diagnostic information
- **`info`:** General informational messages (recommended for production)
- **`warn`:** Warning messages that don't prevent operation
- **`error`:** Error messages only

**Recommendations:**
- **Development:** `level: "debug"`, `pretty: true`
- **Production:** `level: "info"`, `pretty: false`
- **Troubleshooting:** `level: "trace"`, `pretty: true`

---

### Complete Configuration Example

```json
{
  "databases": [
    {
      "id": "postgres-production",
      "type": "postgres",
      "url": "${DATABASE_URL}",
      "readOnly": true,
      "pool": {
        "min": 5,
        "max": 20,
        "idleTimeoutMillis": 60000,
        "connectionTimeoutMillis": 5000
      },
      "introspection": {
        "includeViews": true,
        "includeRoutines": false,
        "excludeSchemas": ["pg_catalog", "information_schema"]
      },
      "eagerConnect": true
    },
    {
      "id": "mysql-analytics",
      "type": "mysql",
      "url": "${MYSQL_URL}",
      "readOnly": true,
      "pool": {
        "min": 2,
        "max": 10
      },
      "introspection": {
        "includeViews": true,
        "maxTables": 100
      }
    },
    {
      "id": "sqlite-local",
      "type": "sqlite",
      "path": "./data/app.db",
      "readOnly": false
    }
  ],
  "cache": {
    "directory": ".sql-mcp-cache",
    "ttlMinutes": 60
  },
  "security": {
    "allowWrite": false,
    "allowedWriteOperations": ["INSERT", "UPDATE"],
    "disableDangerousOperations": true,
    "redactSecrets": true
  },
  "logging": {
    "level": "info",
    "pretty": false
  }
}
```

---

### Environment Variables

**Secure Configuration with Environment Variables:**

The server supports environment variable interpolation using `${VARIABLE_NAME}` syntax. This is the recommended approach for managing sensitive credentials.

**Example Configuration:**
```json
{
  "databases": [
    {
      "id": "production-db",
      "type": "postgres",
      "url": "${DATABASE_URL}"
    }
  ]
}
```

**Environment File (`.env`):**
```env
DATABASE_URL=postgresql://user:password@localhost:5432/dbname
DB_URL_MYSQL=mysql://user:password@localhost:3306/dbname
DB_URL_MSSQL=Server=host,1433;Database=db;User Id=sa;Password=pass
```

**Best Practices:**
- ✅ Store `.env` file outside version control (add to `.gitignore`)
- ✅ Use different `.env` files for each environment (dev, staging, prod)
- ✅ Never commit credentials to git repositories
- ✅ Use secret management services (AWS Secrets Manager, HashiCorp Vault) in production

---

### Connection String Reference

| Database | Format | Example |
|----------|--------|---------|
| **PostgreSQL** | `postgresql://user:pass@host:port/db` | `postgresql://admin:secret@localhost:5432/myapp` |
| **MySQL** | `mysql://user:pass@host:port/db` | `mysql://root:password@localhost:3306/myapp` |
| **SQL Server** | `Server=host,port;Database=db;User Id=user;Password=pass` | `Server=localhost,1433;Database=myapp;User Id=sa;Password=secret` |
| **SQLite** | Use `path` property | `"path": "./data/app.db"` or `"path": "/var/db/app.sqlite"` |
| **Oracle** | `user/pass@host:port/service` | `admin/secret@localhost:1521/XEPDB1` |

**Additional Parameters:**

**PostgreSQL:**
```
postgresql://user:pass@host:5432/db?sslmode=require&connect_timeout=10
```

**MySQL:**
```
mysql://user:pass@host:3306/db?charset=utf8mb4&timezone=Z
```

**SQL Server:**
```
Server=host;Database=db;User Id=user;Password=pass;Encrypt=true;TrustServerCertificate=false
```

---

## MCP Client Integration

### Configuration File Locations

| MCP Client | Configuration File Path |
|------------|------------------------|
| **Claude Desktop** (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Claude Desktop** (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Cline** (VS Code) | VS Code settings → MCP Servers |
| **Other Clients** | Refer to client-specific documentation |

### Setup Methods

#### Method 1: Global npm Installation

**Configuration:**
```json
{
  "mcpServers": {
    "database": {
      "command": "mcp-database-server",
      "args": ["--config", "/absolute/path/to/.mcp-database-server.config"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/db"
      }
    }
  }
}
```

#### Method 2: Source Installation

**Configuration:**
```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/index.js",
        "--config",
        "/absolute/path/to/.mcp-database-server.config"
      ],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/db"
      }
    }
  }
}
```

### Configuration Properties

| Property | Description | Example |
|----------|-------------|---------|
| `command` | Executable to run. Use `mcp-database-server` for npm install, `node` for source install. | `"mcp-database-server"` |
| `args` | Array of command-line arguments. First arg is usually `--config` followed by config file path. | `["--config", "/path/to/config"]` |
| `env` | Environment variables passed to the server. Used for secure credential management. | `{"DATABASE_URL": "..."}` |

**Finding Absolute Paths:**
```bash
# macOS/Linux
cd /path/to/mcp-database-server
pwd  # prints: /Users/username/projects/mcp-database-server

# Windows (PowerShell)
cd C:\path\to\mcp-database-server
$PWD.Path  # prints: C:\Users\username\projects\mcp-database-server
```

---

## Available MCP Tools

This server provides 9 tools for comprehensive database interaction.

### Tool Reference

| Tool | Purpose | Write Access | Cached Data |
|------|---------|--------------|-------------|
| `list_databases` | List all configured databases with status | No | Uses cache |
| `introspect_schema` | Discover and cache database schema | No | Writes cache |
| `get_schema` | Retrieve cached schema metadata | No | Reads cache |
| `run_query` | Execute SQL queries with safety controls | Conditional* | Updates stats |
| `explain_query` | Analyze query execution plans | No | No cache |
| `suggest_joins` | Get intelligent join path recommendations | No | Uses cache |
| `clear_cache` | Clear schema cache and statistics | No | Clears cache |
| `cache_status` | View cache health and statistics | No | Reads cache |
| `health_check` | Test database connectivity | No | No cache |

<sub>* Requires `allowWrite: true` and respects security settings</sub>

---

### 1. list_databases

Lists all configured databases with their connection status and cache information.

**Input Parameters:**

None required.

**Response:**
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

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Database identifier from configuration |
| `type` | string | Database type (postgres, mysql, sqlite, mssql, oracle) |
| `connected` | boolean | Whether database connection is active |
| `cached` | boolean | Whether schema is currently cached |
| `cacheAge` | number | Age of cached schema in milliseconds (if cached) |
| `version` | string | Cache version hash (if cached) |

---

### 2. introspect_schema

Discovers and caches complete database schema including tables, columns, indexes, foreign keys, and relationships.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbId` | string | Yes | Database identifier to introspect |
| `forceRefresh` | boolean | No | Force re-introspection even if cache is valid (default: `false`) |
| `schemaFilter` | object | No | Filter which objects to introspect |
| `schemaFilter.includeSchemas` | string[] | No | Only introspect these schemas (PostgreSQL/SQL Server) |
| `schemaFilter.excludeSchemas` | string[] | No | Skip these schemas during introspection |
| `schemaFilter.includeViews` | boolean | No | Include database views (default: `true`) |
| `schemaFilter.maxTables` | number | No | Limit to first N tables |

**Example Request:**
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

**Response:**
```json
{
  "dbId": "postgres-main",
  "version": "a1b2c3d4",
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

---

### 3. get_schema

Retrieves detailed schema metadata from cache without querying the database.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbId` | string | Yes | Database identifier |
| `schema` | string | No | Filter to specific schema name |
| `table` | string | No | Filter to specific table name |

**Example Request:**
```json
{
  "dbId": "postgres-main",
  "schema": "public",
  "table": "users"
}
```

**Response:** Complete schema metadata including tables, columns, data types, indexes, foreign keys, and inferred relationships.

---

### 4. run_query

Executes SQL queries with automatic schema caching, relationship annotation, and comprehensive security controls.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbId` | string | Yes | Database identifier to query |
| `sql` | string | Yes | SQL query to execute |
| `params` | array | No | Parameterized query values (prevents SQL injection) |
| `limit` | number | No | Maximum number of rows to return |
| `timeoutMs` | number | No | Query timeout in milliseconds |

**Example Request:**
```json
{
  "dbId": "postgres-main",
  "sql": "SELECT * FROM users WHERE active = $1 LIMIT $2",
  "params": [true, 10],
  "timeoutMs": 5000
}
```

**Response:**
```json
{
  "rows": [
    {"id": 1, "name": "Alice", "email": "alice@example.com", "active": true},
    {"id": 2, "name": "Bob", "email": "bob@example.com", "active": true}
  ],
  "columns": ["id", "name", "email", "active"],
  "rowCount": 2,
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

**Security Controls:**
- ✅ Write operations blocked by default (`allowWrite: false`)
- ✅ Dangerous operations (DELETE, TRUNCATE, DROP) disabled by default
- ✅ Specific operations can be whitelisted via `allowedWriteOperations`
- ✅ Per-database `readOnly` mode

---

### 5. explain_query

Retrieves database query execution plan without executing the query.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbId` | string | Yes | Database identifier |
| `sql` | string | Yes | SQL query to analyze |
| `params` | array | No | Query parameters (for parameterized queries) |

**Example Request:**
```json
{
  "dbId": "postgres-main",
  "sql": "SELECT * FROM users JOIN orders ON users.id = orders.user_id WHERE users.active = $1",
  "params": [true]
}
```

**Response:** Database-native execution plan (format varies by database type).

---

### 6. suggest_joins

Analyzes relationship graph to recommend optimal join paths between multiple tables.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbId` | string | Yes | Database identifier |
| `tables` | string[] | Yes | Array of table names to join (2-10 tables) |

**Example Request:**
```json
{
  "dbId": "postgres-main",
  "tables": ["users", "orders", "products"]
}
```

**Response:**
```json
[
  {
    "tables": ["users", "orders", "products"],
    "joins": [
      {
        "fromTable": "users",
        "toTable": "orders",
        "relationship": {
          "type": "one-to-many",
          "confidence": 1.0
        },
        "joinCondition": "users.id = orders.user_id"
      },
      {
        "fromTable": "orders",
        "toTable": "products",
        "relationship": {
          "type": "many-to-one",
          "confidence": 1.0
        },
        "joinCondition": "orders.product_id = products.id"
      }
    ],
    "sql": "FROM users JOIN orders ON users.id = orders.user_id JOIN products ON orders.product_id = products.id"
  }
]
```

---

### 7. clear_cache

Clears schema cache and query statistics for one or all databases.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbId` | string | No | Database to clear (omit to clear all) |

**Example Request:**
```json
{
  "dbId": "postgres-main"
}
```

**Response:** Confirmation message.

---

### 8. cache_status

Retrieves detailed cache statistics and health information.

**Input Parameters:**

None required.

**Response:**
```json
{
  "directory": ".sql-mcp-cache",
  "ttlMinutes": 10,
  "databases": [
    {
      "dbId": "postgres-main",
      "cached": true,
      "version": "abc123",
      "age": 120000,
      "expired": false,
      "tableCount": 15,
      "sizeBytes": 45678
    }
  ]
}
```

---

### 9. health_check

Tests database connectivity and returns status information.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbId` | string | No | Database to check (omit to check all) |

**Response:**
```json
{
  "databases": [
    {
      "dbId": "postgres-main",
      "healthy": true,
      "connected": true,
      "version": "PostgreSQL 15.3",
      "responseTimeMs": 12
    }
  ]
}
```

---

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