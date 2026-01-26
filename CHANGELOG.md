# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-26

### Added

#### Core Features
- Model Context Protocol (MCP) server implementation over stdio
- Multi-database support with unified interface
- Automatic schema introspection and caching
- Relationship discovery (foreign keys + heuristic inference)
- Query tracking and execution statistics
- Intelligent join path suggestions

#### Database Adapters
- PostgreSQL adapter with full schema introspection
- MySQL/MariaDB adapter with connection pooling
- SQLite adapter for file-based databases
- SQL Server adapter with tedious driver
- Oracle adapter stub (requires Instant Client setup)

#### MCP Tools
- `list_databases` - List configured databases with status
- `introspect_schema` - Introspect and cache database schema
- `get_schema` - Retrieve cached schema metadata
- `run_query` - Execute SQL with relationship annotations
- `explain_query` - Get database execution plans
- `suggest_joins` - Intelligent join recommendations
- `clear_cache` - Clear schema cache and query history
- `cache_status` - Get cache statistics and status
- `health_check` - Database connectivity and version info

#### MCP Resources
- Schema resources exposed as `schema://{dbId}`
- JSON-formatted schema metadata

#### Configuration
- JSON-based configuration with Zod validation
- Environment variable interpolation support
- Per-database connection pool settings
- Introspection filtering options
- Security controls (read-only, write restrictions)
- Cache TTL configuration
- Logging level configuration

#### Caching System
- Dual-layer cache (memory + disk persistence)
- TTL-based expiration
- Content-based versioning (SHA-256 hash)
- Concurrency-safe introspection
- Per-database cache management

#### Security
- Secret redaction in logs and outputs
- Read-only mode enforcement
- Write operation whitelist
- Environment variable support for credentials
- Connection string encryption support

#### Developer Experience
- TypeScript with strict type checking
- Comprehensive test suite (vitest)
- ESLint + Prettier configuration
- Build system with tsup
- Development and production modes
- Extensive documentation

#### Documentation
- Comprehensive README with examples
- Quick Start guide
- Configuration reference
- Tool documentation
- Troubleshooting guide
- Contributing guidelines

### Technical Details

#### Dependencies
- @modelcontextprotocol/sdk: MCP protocol implementation
- pg: PostgreSQL driver
- mysql2: MySQL driver with promises
- better-sqlite3: Synchronous SQLite driver
- tedious: SQL Server driver
- oracledb: Oracle driver (optional)
- zod: Schema validation
- pino: Structured logging
- dotenv: Environment variable management

#### Architecture
- Adapter pattern for database abstraction
- Centralized database manager
- Event-driven query tracking
- Graph-based relationship discovery
- Persistent cache layer
- Type-safe configuration

#### Testing
- Unit tests for utilities
- Cache functionality tests
- Adapter interface tests
- Configuration validation tests

### Notes

#### CockroachDB Support
Works through PostgreSQL adapter (wire protocol compatible)

#### Amazon Aurora Support
- Aurora PostgreSQL: Use PostgreSQL adapter
- Aurora MySQL: Use MySQL adapter

#### Oracle Limitations
Oracle adapter is a stub implementation. Full support requires:
1. Oracle Instant Client installation
2. Environment configuration
3. Implementation of stub methods

### Future Considerations

Potential enhancements for future releases:
- Connection pooling improvements
- Advanced query analysis
- Schema diff detection
- Migration tracking
- Multi-tenant support
- Performance monitoring
- Real-time schema change detection
- Additional database adapters (ClickHouse, TimescaleDB, etc.)
- Query result caching
- Prepared statement caching
- Transaction support
- Stored procedure introspection
