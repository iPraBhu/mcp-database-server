import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findConfigFile } from './config.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

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
