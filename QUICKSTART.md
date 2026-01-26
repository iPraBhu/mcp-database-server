# Quick Start Guide

This guide will help you get up and running with sql-mcp in minutes.

## Prerequisites

- Node.js 18 or higher
- One or more SQL databases (PostgreSQL, MySQL, SQLite, SQL Server)

## Installation

1. Clone or download this repository
2. Install dependencies:

```bash
npm install
```

3. Build the project:

```bash
npm run build
```

## Configuration

### Step 1: Create Environment File

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your database credentials:

```env
DB_URL_POSTGRES=postgresql://user:password@localhost:5432/dbname
DB_URL_MYSQL=mysql://user:password@localhost:3306/dbname
```

### Step 2: Create Configuration File

The repository includes a sample `sql-mcp.config.json`. Customize it for your needs:

```json
{
  "databases": [
    {
      "id": "my-postgres",
      "type": "postgres",
      "url": "${DB_URL_POSTGRES}",
      "readOnly": true
    }
  ],
  "cache": {
    "ttlMinutes": 10
  },
  "security": {
    "allowWrite": false
  }
}
```

### Step 3: Test Connection

Run a quick health check:

```bash
node dist/index.js --config ./sql-mcp.config.json
```

Then use an MCP client to call the `health_check` tool.

## MCP Client Setup

### Claude Desktop

Add to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/sql-mcp/dist/index.js",
        "--config",
        "/absolute/path/to/sql-mcp.config.json"
      ]
    }
  }
}
```

### Other MCP Clients

Configure according to your MCP client's documentation, using:
- **Command:** `node`
- **Args:** `["/path/to/dist/index.js", "--config", "/path/to/config.json"]`

## First Steps

Once connected, try these commands in your MCP client:

### 1. List Databases

```
Use the list_databases tool
```

### 2. Introspect Schema

```
Use introspect_schema with dbId: "my-postgres"
```

### 3. Run a Query

```
Use run_query with:
- dbId: "my-postgres"
- sql: "SELECT * FROM users LIMIT 10"
```

### 4. Get Join Suggestions

```
Use suggest_joins with:
- dbId: "my-postgres"  
- tables: ["users", "orders"]
```

## SQLite Quick Start

For a quick test with SQLite (no database server needed):

1. Create a SQLite database:

```bash
mkdir -p data
sqlite3 data/test.db << EOF
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount REAL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO users VALUES (1, 'Alice', 'alice@example.com');
INSERT INTO users VALUES (2, 'Bob', 'bob@example.com');
INSERT INTO orders VALUES (1, 1, 99.99);
INSERT INTO orders VALUES (2, 1, 149.99);
INSERT INTO orders VALUES (3, 2, 49.99);
EOF
```

2. Configure sql-mcp.config.json:

```json
{
  "databases": [
    {
      "id": "test-db",
      "type": "sqlite",
      "path": "./data/test.db"
    }
  ]
}
```

3. Start using it!

## Common Issues

### "Connection refused"

- Verify database is running
- Check connection URL and credentials
- Ensure firewall allows connections

### "Module not found"

- Run `npm install` and `npm run build`
- Check that you're running from the project directory

### "Permission denied"

- Check file permissions on SQLite database
- Ensure cache directory is writable

### "Write operations not allowed"

- Set `"allowWrite": true` in security config
- Or use read-only queries only

## Next Steps

- Read the full [README.md](README.md) for detailed documentation
- Explore all available tools
- Set up multiple databases
- Configure caching and security options
- Write custom queries and leverage relationship discovery

## Getting Help

- Check the [README.md](README.md) for troubleshooting
- Review the configuration examples
- Enable debug logging: `"logging": { "level": "debug" }`
