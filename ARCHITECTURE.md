# SQL MCP Server Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      MCP Client                              │
│            (Claude Desktop, etc.)                            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ stdio (JSON-RPC)
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   MCP Server                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Tool Request Handlers                      │ │
│  │  • list_databases    • get_schema    • clear_cache     │ │
│  │  • introspect_schema • run_query     • cache_status    │ │
│  │  • suggest_joins     • explain_query • health_check    │ │
│  └────────────┬───────────────────────────────────────────┘ │
│               │                                              │
│  ┌────────────▼───────────────────────────────────────────┐ │
│  │          Database Manager                              │ │
│  │  • Connection management                               │ │
│  │  • Schema introspection orchestration                  │ │
│  │  • Query execution and tracking                        │ │
│  │  • Security enforcement                                │ │
│  └────┬──────────────────┬──────────────────┬────────────┘ │
│       │                  │                  │               │
│  ┌────▼────┐       ┌────▼────┐       ┌────▼────┐          │
│  │ Schema  │       │  Query  │       │ Adapter │          │
│  │  Cache  │       │ Tracker │       │ Factory │          │
│  └─────────┘       └─────────┘       └────┬────┘          │
└───────────────────────────────────────────┼───────────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
              ┌─────▼─────┐           ┌───▼────┐           ┌──────▼──────┐
              │ Postgres  │           │ MySQL  │           │   SQLite    │
              │  Adapter  │           │ Adapter│           │   Adapter   │
              └─────┬─────┘           └───┬────┘           └──────┬──────┘
                    │                     │                        │
              ┌─────▼─────┐           ┌───▼────┐           ┌──────▼──────┐
              │    pg     │           │ mysql2 │           │better-sqlite│
              │  driver   │           │ driver │           │   driver    │
              └─────┬─────┘           └───┬────┘           └──────┬──────┘
                    │                     │                        │
              ┌─────▼─────┐           ┌───▼────┐           ┌──────▼──────┐
              │ PostgreSQL│           │  MySQL │           │   SQLite    │
              │  Database │           │Database│           │   Database  │
              └───────────┘           └────────┘           └─────────────┘
```

## Component Details

### MCP Server Layer
**Purpose**: Protocol implementation and request routing

**Responsibilities**:
- Handle MCP protocol (stdio, JSON-RPC)
- Route tool calls to appropriate handlers
- Expose resources (cached schemas)
- Format responses per MCP spec
- Error handling and logging

**Key Files**:
- `src/mcp-server.ts`
- `src/index.ts`

### Database Manager
**Purpose**: Central orchestration and business logic

**Responsibilities**:
- Manage multiple database connections
- Coordinate schema introspection
- Execute queries with safety checks
- Track query history
- Enforce security policies
- Manage cache lifecycle

**Key Files**:
- `src/database-manager.ts`

### Schema Cache
**Purpose**: Persistent schema storage with TTL

**Responsibilities**:
- In-memory + disk caching
- TTL-based expiration
- Content versioning (SHA-256)
- Relationship building
- Concurrency control (locks)
- Cache statistics

**Key Files**:
- `src/cache.ts`

**Storage**:
```
.sql-mcp-cache/
├── postgres-main.json
├── mysql-analytics.json
└── sqlite-local.json
```

### Query Tracker
**Purpose**: Query history and statistics

**Responsibilities**:
- Track last N queries per database
- Record execution time and row counts
- Extract referenced tables
- Calculate aggregate statistics
- Error tracking

**Key Files**:
- `src/query-tracker.ts`

### Adapter Layer
**Purpose**: Database abstraction

**Responsibilities**:
- Implement common interface for all DBs
- Connection management
- Schema introspection
- Query execution
- Explain plan retrieval
- Database-specific SQL generation

**Key Files**:
- `src/adapters/base.ts` (abstract base)
- `src/adapters/postgres.ts`
- `src/adapters/mysql.ts`
- `src/adapters/sqlite.ts`
- `src/adapters/mssql.ts`
- `src/adapters/oracle.ts` (stub)
- `src/adapters/index.ts` (factory)

**Interface**:
```typescript
interface DatabaseAdapter {
  connect(): Promise<void>
  disconnect(): Promise<void>
  introspect(options?): Promise<DatabaseSchema>
  query(sql, params?, timeout?): Promise<QueryResult>
  explain(sql, params?): Promise<ExplainResult>
  testConnection(): Promise<boolean>
  getVersion(): Promise<string>
}
```

## Data Flow

### Schema Introspection Flow
```
Tool Call (introspect_schema)
    ↓
Database Manager
    ↓
Check Cache (with TTL)
    ↓ (miss or expired)
Acquire Lock
    ↓
Database Adapter
    ↓
Query information_schema / system tables
    ↓
Build normalized schema structure
    ↓
Generate version hash
    ↓
Discover relationships
    ↓
Save to Cache (memory + disk)
    ↓
Release Lock
    ↓
Return schema summary
```

### Query Execution Flow
```
Tool Call (run_query)
    ↓
Database Manager
    ↓
Check write operation + security
    ↓
Ensure schema cached
    ↓
Database Adapter
    ↓
Execute query with timeout
    ↓
Track in Query Tracker
    ↓
Annotate with relationships
    ↓
Return results + metadata
```

### Relationship Discovery Flow
```
Schema Introspection Complete
    ↓
Extract explicit foreign keys
    ↓
For each table:
    ↓
  For each column:
      ↓
    Match patterns ({table}_id, {table}Id)
        ↓
      Find referenced table
          ↓
        Check PK compatibility
            ↓
          Add inferred relationship
              ↓
Deduplicate relationships
    ↓
Store in cache
```

## Security Architecture

```
┌─────────────────────────────────────┐
│         Config Validation            │
│  • Zod schema validation             │
│  • Environment interpolation         │
│  • Duplicate ID check                │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│      Database Manager                │
│  • Read-only enforcement             │
│  • Write operation detection         │
│  • Operation whitelist check         │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│       Output Processing              │
│  • Secret redaction in URLs          │
│  • Credential masking in logs        │
│  • Error message sanitization        │
└─────────────────────────────────────┘
```

## Cache Architecture

```
┌────────────────────────────────────────────────┐
│              Cache Layer                        │
│                                                 │
│  ┌──────────────────┐    ┌──────────────────┐ │
│  │   Memory Cache   │    │    Disk Cache    │ │
│  │   (Map<id, *>)   │◄──►│  (.sql-mcp-cache)│ │
│  └──────────────────┘    └──────────────────┘ │
│           ▲                        ▲            │
│           │                        │            │
│  ┌────────┴────────┐    ┌─────────┴─────────┐ │
│  │   TTL Checker   │    │  Version Manager  │ │
│  │  (age vs. TTL)  │    │  (SHA-256 hash)   │ │
│  └─────────────────┘    └───────────────────┘ │
│                                                 │
│  ┌──────────────────────────────────────────┐ │
│  │      Introspection Lock Manager          │ │
│  │  (Prevent concurrent introspection)      │ │
│  └──────────────────────────────────────────┘ │
└────────────────────────────────────────────────┘
```

## Configuration Flow

```
Command Line Args
    ↓
Load config file path
    ↓
Read JSON file
    ↓
Interpolate ${ENV_VARS}
    ↓
Validate with Zod schemas
    ↓
Check business rules
    ↓
Initialize components
```

## Error Handling Strategy

```
Database Operation Error
    ↓
Adapter catches native error
    ↓
Wrap in DatabaseError
    ↓
Add context (dbId, operation)
    ↓
Log with structured logger
    ↓
Return MCP error response
    ↓
Client receives formatted error
```

## Scalability Considerations

### Connection Pooling
- Configurable min/max connections per database
- Idle timeout management
- Connection reuse

### Cache Management
- TTL prevents stale data
- Disk persistence reduces re-introspection
- Per-database isolation
- Lock prevents thundering herd

### Query Limits
- Configurable row limits
- Query timeouts
- Result set capping

### Concurrency
- Lock-free reads from cache
- Write locks for introspection
- Async operations throughout

## Monitoring Points

### Performance
- Query execution time (tracked)
- Schema introspection time
- Cache hit/miss ratio
- Connection pool utilization

### Health
- Database connectivity (health_check)
- Cache status and age
- Error rates (tracked)
- Connection failures

### Usage
- Queries per database
- Most used tables
- Write operation frequency
- Cache refresh frequency

## Extension Points

### Adding New Databases
1. Implement `DatabaseAdapter` interface
2. Add to adapter factory
3. Update type definitions
4. Add tests

### Adding New Tools
1. Define JSON schema
2. Add to tool list
3. Implement handler
4. Update documentation

### Adding New Resources
1. Define URI pattern
2. Add to resource list
3. Implement reader
4. Update documentation

---

This architecture provides:
- ✅ Clear separation of concerns
- ✅ Extensibility through interfaces
- ✅ Security by default
- ✅ Performance through caching
- ✅ Reliability through error handling
- ✅ Observability through logging and tracking
