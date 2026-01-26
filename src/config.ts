import fs from 'fs/promises';
import { ServerConfig, ServerConfigSchema, ConfigError } from './types.js';
import { interpolateEnv } from './utils.js';

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
