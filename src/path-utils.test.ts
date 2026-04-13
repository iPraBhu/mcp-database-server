import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveConfigRelativePath } from '../src/path-utils.js';

describe('resolveConfigRelativePath', () => {
  it('resolves relative paths relative to config file directory (Windows-style config path)', () => {
    const configPath = 'C:\\QNST\\services\\.mcp-database-server.config';
    const resolved = resolveConfigRelativePath(configPath, '.sql-mcp-cache');

    expect(resolved).toBe(path.win32.resolve('C:\\QNST\\services', '.sql-mcp-cache'));
  });

  it('preserves Windows absolute paths (drive letter) without prefixing cwd', () => {
    const configPath = 'C:\\QNST\\services\\.mcp-database-server.config';
    const resolved = resolveConfigRelativePath(configPath, 'C:\\QNST\\services\\.sql-mcp-cache');

    expect(resolved).toBe(path.win32.normalize('C:\\QNST\\services\\.sql-mcp-cache'));
    expect(resolved.includes('C:\\Windows\\System32')).toBe(false);
  });
});
