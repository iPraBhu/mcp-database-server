import path from 'path';

function looksLikeWindowsAbsolutePath(value: string): boolean {
  return path.win32.isAbsolute(value) || value.startsWith('\\\\');
}

function isWindowsStylePath(value: string): boolean {
  return looksLikeWindowsAbsolutePath(value) || /^[a-zA-Z]:/.test(value);
}

function getConfigDir(configPath: string): { dir: string; windowsStyle: boolean } {
  if (isWindowsStylePath(configPath)) {
    return {
      dir: path.win32.dirname(path.win32.resolve(configPath)),
      windowsStyle: true,
    };
  }

  return {
    dir: path.dirname(path.resolve(configPath)),
    windowsStyle: false,
  };
}

/**
 * Resolve a path from a config file location.
 *
 * - Relative paths are resolved relative to the directory containing the config file.
 * - Absolute Windows paths (e.g. "C:\\foo" or "\\\\server\\share") are preserved.
 * - Absolute POSIX paths (e.g. "/var/tmp") are preserved.
 */
export function resolveConfigRelativePath(configPath: string, value: string): string {
  const { dir: configDir, windowsStyle } = getConfigDir(configPath);

  if (looksLikeWindowsAbsolutePath(value)) {
    return path.win32.normalize(value);
  }

  if (path.posix.isAbsolute(value)) {
    return windowsStyle ? path.win32.resolve(value) : path.posix.normalize(value);
  }

  return windowsStyle ? path.win32.resolve(configDir, value) : path.resolve(configDir, value);
}
