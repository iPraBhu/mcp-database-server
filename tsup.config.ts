import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  splitting: false,
  bundle: true,
  platform: 'node',
  target: 'node18',
  outDir: 'dist',
});
