import dotenv from 'dotenv';
import { exec } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { promisify } from 'util';
import { ServerConfig, ServerConfigSchema, ConfigError } from './types.js';
import { interpolateEnv } from './utils.js';

const execAsync = promisify(exec);

interface LoadConfigOptions {
  allowCredentialCommand?: boolean;
}

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
  const projectRoot = findProjectRoot(startDir);
  if (projectRoot) {
    return findConfigFileFromDir(fileName, startDir, projectRoot);
  }

  return findConfigFileFromDir(fileName, startDir);
}

/**
 * Find config file by traversing up from a specific directory
 * @param fileName - Name of the config file to find
 * @param startDir - Directory to start searching from
 * @returns Absolute path to config file or null if not found
 */
function findConfigFileFromDir(
  fileName: string,
  startDir: string,
  stopDir?: string
): string | null {
  let currentDir = resolve(startDir);
  const resolvedStopDir = stopDir ? resolve(stopDir) : undefined;

  while (true) {
    const configPath = join(currentDir, fileName);
    
    if (existsSync(configPath)) {
      return configPath;
    }

    if (resolvedStopDir && currentDir === resolvedStopDir) {
      break;
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

export async function loadConfig(
  configPath: string,
  options: LoadConfigOptions = {}
): Promise<ServerConfig> {
  try {
    loadConfigEnvironment(configPath);

    const content = await fs.readFile(configPath, 'utf-8');
    const rawConfig = JSON.parse(content);

    // Interpolate environment variables in all string values
    const interpolatedConfig = interpolateConfigValues(rawConfig);

    // Validate with Zod
    const config = ServerConfigSchema.parse(interpolatedConfig);
    const resolvedConfig = await resolveDatabaseConnectionSources(
      config,
      options.allowCredentialCommand ?? true
    );

    // Additional validation
    validateDatabaseConfigs(resolvedConfig);

    return resolvedConfig;
  } catch (error: any) {
    if (error.name === 'ZodError') {
      throw new ConfigError('Configuration validation failed', error.errors);
    }
    throw new ConfigError(`Failed to load config from ${configPath}: ${error.message}`);
  }
}

function loadConfigEnvironment(configPath: string): void {
  const envPath = join(dirname(resolve(configPath)), '.env');
  if (!existsSync(envPath)) {
    return;
  }

  dotenv.config({
    path: envPath,
    override: false,
  });
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

async function resolveDatabaseConnectionSources(
  config: ServerConfig,
  allowCredentialCommand: boolean
): Promise<ServerConfig> {
  const databases = await Promise.all(
    config.databases.map(async (db) => {
      const connectionSources = [
        db.path ? 'path' : null,
        db.url ? 'url' : null,
        db.secretRef ? 'secretRef' : null,
        db.credentialCommand ? 'credentialCommand' : null,
      ].filter(Boolean);

      if (db.type === 'sqlite') {
        if (connectionSources.length === 0) {
          return db;
        }
        if (connectionSources.length > 1) {
          throw new ConfigError(
            `SQLite database ${db.id} must declare only one of 'path', 'url', 'secretRef', or 'credentialCommand'`
          );
        }
      } else {
        if (db.path) {
          throw new ConfigError(`Database ${db.id} cannot use 'path' unless type is 'sqlite'`);
        }
        const remoteSources = [db.url ? 'url' : null, db.secretRef ? 'secretRef' : null, db.credentialCommand ? 'credentialCommand' : null].filter(Boolean);
        if (remoteSources.length === 0) {
          return db;
        }
        if (remoteSources.length > 1) {
          throw new ConfigError(
            `Database ${db.id} must declare only one of 'url', 'secretRef', or 'credentialCommand'`
          );
        }
      }

      if (db.secretRef) {
        const resolvedSecret = process.env[db.secretRef];
        if (!resolvedSecret) {
          throw new ConfigError(
            `Database ${db.id} references missing secret '${db.secretRef}'. Set it in the environment or the config directory .env file.`
          );
        }

        return {
          ...db,
          url: resolvedSecret,
        };
      }

      if (db.credentialCommand) {
        if (!allowCredentialCommand) {
          throw new ConfigError(
            `Database ${db.id} uses credentialCommand, which requires an explicit --config path for safety.`
          );
        }

        const resolvedCredential = await runCredentialCommand(db.id, db.credentialCommand);
        return {
          ...db,
          url: resolvedCredential,
        };
      }

      return db;
    })
  );

  return {
    ...config,
    databases,
  };
}

async function runCredentialCommand(dbId: string, command: string): Promise<string> {
  try {
    const { stdout } = await execAsync(command, {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const value = stdout.trim();

    if (!value) {
      throw new ConfigError(
        `credentialCommand for database ${dbId} returned an empty value`
      );
    }

    return value;
  } catch (error: any) {
    if (error instanceof ConfigError) {
      throw error;
    }

    throw new ConfigError(
      `credentialCommand for database ${dbId} failed: ${error.message}`
    );
  }
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
        throw new ConfigError(
          `SQLite database ${db.id} requires one of 'path', 'url', 'secretRef', or 'credentialCommand'`
        );
      }
    } else {
      if (!db.url) {
        throw new ConfigError(
          `Database ${db.id} requires one of 'url', 'secretRef', or 'credentialCommand'`
        );
      }
    }
  }
}
