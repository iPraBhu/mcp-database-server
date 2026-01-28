import fs from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { ServerConfig, ServerConfigSchema, ConfigError } from './types.js';
import { interpolateEnv } from './utils.js';

/**
 * Find project root by looking for common project markers
 * @param startDir - Directory to start searching from (defaults to cwd)
 * @returns Absolute path to project root or null if not found
 */
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  const projectMarkers = ['package.json', '.git', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
  let currentDir = resolve(startDir);

  while (true) {
    for (const marker of projectMarkers) {
      if (existsSync(join(currentDir, marker))) {
        return currentDir;
      }
    }

    const parentDir = dirname(currentDir);
    
    // Reached filesystem root (parent equals current)
    if (parentDir === currentDir) {
      break;
    }

    // Move up one directory
    currentDir = parentDir;
  }

  return null;
}

/**
 * Find config file by traversing up the directory tree
 * @param fileName - Name of the config file to find
 * @param startDir - Directory to start searching from (defaults to cwd)
 * @returns Absolute path to config file or null if not found
 */
export function findConfigFile(fileName: string, startDir: string = process.cwd()): string | null {
  // First try to find project root and search from there
  const projectRoot = findProjectRoot(startDir);
  if (projectRoot) {
    const configFromProjectRoot = findConfigFileFromDir(fileName, projectRoot);
    if (configFromProjectRoot) {
      return configFromProjectRoot;
    }
  }

  // Fallback to searching from the original start directory
  return findConfigFileFromDir(fileName, startDir);
}

/**
 * Find config file by traversing up from a specific directory
 * @param fileName - Name of the config file to find
 * @param startDir - Directory to start searching from
 * @returns Absolute path to config file or null if not found
 */
function findConfigFileFromDir(fileName: string, startDir: string): string | null {
  let currentDir = resolve(startDir);

  while (true) {
    const configPath = join(currentDir, fileName);
    
    if (existsSync(configPath)) {
      return configPath;
    }

    const parentDir = dirname(currentDir);
    
    // Reached filesystem root (parent equals current)
    if (parentDir === currentDir) {
      break;
    }

    // Move up one directory
    currentDir = parentDir;
  }

  return null;
}

export async function loadConfig(configPath: string): Promise<ServerConfig> {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const rawConfig = JSON.parse(content);

    // Interpolate environment variables in all string values
    const interpolatedConfig = interpolateConfigValues(rawConfig);

    // Validate with Zod
    const config = ServerConfigSchema.parse(interpolatedConfig);

    // Additional validation
    validateDatabaseConfigs(config);

    return config;
  } catch (error: any) {
    if (error.name === 'ZodError') {
      throw new ConfigError('Configuration validation failed', error.errors);
    }
    throw new ConfigError(`Failed to load config from ${configPath}: ${error.message}`);
  }
}

function interpolateConfigValues(obj: any): any {
  if (typeof obj === 'string') {
    return interpolateEnv(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(interpolateConfigValues);
  }
  
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateConfigValues(value);
    }
    return result;
  }
  
  return obj;
}

function validateDatabaseConfigs(config: ServerConfig): void {
  const ids = new Set<string>();

  for (const db of config.databases) {
    // Check for duplicate IDs
    if (ids.has(db.id)) {
      throw new ConfigError(`Duplicate database ID: ${db.id}`);
    }
    ids.add(db.id);

    // Validate database-specific requirements
    if (db.type === 'sqlite') {
      if (!db.path && !db.url) {
        throw new ConfigError(`SQLite database ${db.id} requires 'path' or 'url'`);
      }
    } else {
      if (!db.url) {
        throw new ConfigError(`Database ${db.id} requires 'url'`);
      }
    }
  }
}
