#!/usr/bin/env node

import dotenv from 'dotenv';
import { parseArgs } from 'util';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { loadConfig, findConfigFile } from './config.js';
import { DatabaseManager } from './database-manager.js';
import { MCPServer } from './mcp-server.js';
import { initLogger, getLogger } from './logger.js';

// Load environment variables
dotenv.config();

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf-8')
);
const version = packageJson.version;

async function main() {
  try {
    // Parse command line arguments
    const { values } = parseArgs({
      options: {
        config: {
          type: 'string',
          short: 'c',
        },
        help: {
          type: 'boolean',
          short: 'h',
        },
        version: {
          type: 'boolean',
          short: 'v',
        },
      },
    });

    if (values.version) {
      console.log(version);
      process.exit(0);
    }

    if (values.help) {
      console.log(`
mcp-database-server - Model Context Protocol Server for SQL Databases

Usage:
  mcp-database-server [options]

Options:
  -c, --config <path>  Path to configuration file (if not specified, searches for .mcp-database-server.config from project root upwards)
  -h, --help          Show this help message
  -v, --version       Show version number

Configuration:
  The config file should be a JSON file with database configurations.
  See mcp-database-server.config.example for reference.

Environment Variables:
  You can use environment variable interpolation in the config file:
  Example: "url": "\${DB_URL_POSTGRES}"

Examples:
  mcp-database-server --config ./my-config.json
  mcp-database-server -c ./config/production.json
      `);
      process.exit(0);
    }

    // Load configuration
    let configPath: string;
    
    if (values.config) {
      configPath = values.config;
      if (!existsSync(configPath)) {
        console.error(`Error: Specified config file ${configPath} not found`);
        process.exit(1);
      }
    } else {
      // No config specified, search upwards for .mcp-database-server.config
      const foundPath = findConfigFile('.mcp-database-server.config');
      if (foundPath) {
        configPath = foundPath;
      } else {
        console.error('Error: No config file specified, and .mcp-database-server.config not found');
        console.error('Searched in current directory and all parent directories');
        console.error('\nTo create a config file:');
        console.error('  cp mcp-database-server.config.example .mcp-database-server.config');
        console.error('\nOr specify a custom path:');
        console.error('  mcp-database-server --config /path/to/config.json');
        process.exit(1);
      }
    }
    
    const config = await loadConfig(configPath);

    // Initialize logger
    initLogger(config.logging?.level || 'info', config.logging?.pretty || false);
    const logger = getLogger();

    logger.info({ configPath }, 'Configuration loaded');

    // Initialize database manager
    const dbManager = new DatabaseManager(config.databases, {
      cacheDir: config.cache?.directory ? join(process.cwd(), config.cache.directory) : join(os.homedir(), '.sql-mcp-cache'),
      cacheTtlMinutes: config.cache?.ttlMinutes || 10,
      allowWrite: config.security?.allowWrite || false,
      allowedWriteOperations: config.security?.allowedWriteOperations,
      disableDangerousOperations: config.security?.disableDangerousOperations ?? true,
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
