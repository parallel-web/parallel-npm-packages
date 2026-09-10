import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    auto: 'src/auto.ts',
  },
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  dts: true,
  splitting: true,
  clean: true,
  treeshake: true,
  minify: true,
  outDir: 'dist',
});
