#!/usr/bin/env node

import dotenv from 'dotenv';
import { parseArgs } from 'util';
import { loadConfig } from './config.js';
import { DatabaseManager } from './database-manager.js';
import { MCPServer } from './mcp-server.js';
import { initLogger, getLogger } from './logger.js';

// Load environment variables
dotenv.config();

async function main() {
  try {
    // Parse command line arguments
    const { values } = parseArgs({
      options: {
        config: {
          type: 'string',
          short: 'c',
          default: './sql-mcp.config.json',
        },
        help: {
          type: 'boolean',
          short: 'h',
        },
      },
    });

    if (values.help) {
      console.log(`
sql-mcp - Model Context Protocol Server for SQL Databases

Usage:
  sql-mcp [options]

Options:
  -c, --config <path>  Path to configuration file (default: ./sql-mcp.config.json)
  -h, --help          Show this help message

Configuration:
  The config file should be a JSON file with database configurations.
  See sql-mcp.config.json.example for reference.

Environment Variables:
  You can use environment variable interpolation in the config file:
  Example: "url": "\${DB_URL_POSTGRES}"

Examples:
  sql-mcp --config ./my-config.json
  sql-mcp -c ./config/production.json
      `);
      process.exit(0);
    }

    // Load configuration
    const configPath = values.config as string;
    const config = await loadConfig(configPath);

    // Initialize logger
    initLogger(config.logging?.level || 'info', config.logging?.pretty || false);
    const logger = getLogger();

    logger.info({ configPath }, 'Configuration loaded');

    // Initialize database manager
    const dbManager = new DatabaseManager(config.databases, {
      cacheDir: config.cache?.directory || '.sql-mcp-cache',
      cacheTtlMinutes: config.cache?.ttlMinutes || 10,
      allowWrite: config.security?.allowWrite || false,
      allowedWriteOperations: config.security?.allowedWriteOperations,
    });

    await dbManager.init();

    // Create and start MCP server
    const mcpServer = new MCPServer(dbManager, config);
    await mcpServer.start();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down...');
      await dbManager.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error: any) {
    console.error('Fatal error:', error.message);
    if (error.details) {
      console.error('Details:', JSON.stringify(error.details, null, 2));
    }
    process.exit(1);
  }
}

main();
