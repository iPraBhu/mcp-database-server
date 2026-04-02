import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findConfigFile, findProjectRoot, loadConfig } from './config.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

describe('findProjectRoot', () => {
  const testDir = join(process.cwd(), 'test-project-root');
  const subDir1 = join(testDir, 'level1');
  const subDir2 = join(subDir1, 'level2');

  beforeEach(() => {
    // Clean up if exists
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    
    // Create directory structure
    mkdirSync(subDir2, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should find project root with package.json', () => {
    const packageJson = join(testDir, 'package.json');
    writeFileSync(packageJson, '{"name": "test"}');

    const found = findProjectRoot(subDir2);
    expect(found).toBe(testDir);
  });

  it('should find project root with .git', () => {
    mkdirSync(join(testDir, '.git'));
    
    const found = findProjectRoot(subDir2);
    expect(found).toBe(testDir);
  });

  it('should return null when no project markers found', () => {
    // Create a temp directory outside the project
    const tempDir = join(process.cwd(), '..', 'temp-test-dir');
    const tempSubDir = join(tempDir, 'subdir');
    
    // Clean up if exists
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    
    try {
      mkdirSync(tempSubDir, { recursive: true });
      const found = findProjectRoot(tempSubDir);
      expect(found).toBeNull();
    } finally {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });
});

describe('findConfigFile', () => {
  const testDir = join(process.cwd(), 'test-config-discovery');
  const subDir1 = join(testDir, 'level1');
  const subDir2 = join(subDir1, 'level2');
  const configFileName = '.test-config.json';

  beforeEach(() => {
    // Clean up if exists
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    
    // Create directory structure
    mkdirSync(subDir2, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should find config in current directory', () => {
    const configPath = join(testDir, configFileName);
    writeFileSync(configPath, '{}');

    const found = findConfigFile(configFileName, testDir);
    expect(found).toBe(configPath);
  });

  it('should find config in parent directory', () => {
    const configPath = join(testDir, configFileName);
    writeFileSync(configPath, '{}');

    const found = findConfigFile(configFileName, subDir1);
    expect(found).toBe(configPath);
  });

  it('should find config two levels up', () => {
    const configPath = join(testDir, configFileName);
    writeFileSync(configPath, '{}');

    const found = findConfigFile(configFileName, subDir2);
    expect(found).toBe(configPath);
  });

  it('should find config in nearest parent when multiple exist', () => {
    // Create config in root test dir
    const rootConfig = join(testDir, configFileName);
    writeFileSync(rootConfig, '{"root": true}');

    // Create config in level1
    const level1Config = join(subDir1, configFileName);
    writeFileSync(level1Config, '{"level1": true}');

    // Should find the nearest one (level1)
    const found = findConfigFile(configFileName, subDir2);
    expect(found).toBe(level1Config);
  });

  it('should return null when config not found', () => {
    const found = findConfigFile(configFileName, subDir2);
    expect(found).toBeNull();
  });

  it('should work with default cwd', () => {
    const configPath = join(process.cwd(), configFileName);
    writeFileSync(configPath, '{}');

    try {
      const found = findConfigFile(configFileName);
      expect(found).toBe(configPath);
    } finally {
      rmSync(configPath);
    }
  });
});

describe('loadConfig', () => {
  const testDir = join(process.cwd(), 'test-config-loading');
  const configPath = join(testDir, '.mcp-database-server.config');
  const envPath = join(testDir, '.env');

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    delete process.env.TEST_DB_SECRET;
  });

  afterEach(() => {
    delete process.env.TEST_DB_SECRET;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should resolve secretRef from a .env file next to the config', async () => {
    writeFileSync(
      envPath,
      'TEST_DB_SECRET=postgresql://user:pass@localhost:5432/app\n'
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        databases: [
          {
            id: 'main',
            type: 'postgres',
            secretRef: 'TEST_DB_SECRET',
          },
        ],
      })
    );

    const config = await loadConfig(configPath);

    expect(config.databases[0].url).toBe('postgresql://user:pass@localhost:5432/app');
    expect(config.databases[0].secretRef).toBe('TEST_DB_SECRET');
  });

  it('should resolve credentialCommand output into the database url', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        databases: [
          {
            id: 'analytics',
            type: 'mysql',
            credentialCommand:
              'node -e "process.stdout.write(\'mysql://user:pass@localhost:3306/analytics\')"',
          },
        ],
      })
    );

    const config = await loadConfig(configPath);

    expect(config.databases[0].url).toBe('mysql://user:pass@localhost:3306/analytics');
  });

  it('should reject multiple connection sources for the same database', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        databases: [
          {
            id: 'main',
            type: 'postgres',
            url: 'postgresql://user:pass@localhost:5432/app',
            secretRef: 'TEST_DB_SECRET',
          },
        ],
      })
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Database main must declare only one of 'url', 'secretRef', or 'credentialCommand'"
    );
  });
});
