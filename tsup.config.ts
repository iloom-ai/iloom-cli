import { defineConfig } from 'tsup'

export default defineConfig([
  // CLI build configuration
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node16',
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    dts: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
    // Copy templates directory to dist
    publicDir: 'templates',
    outExtension() {
      return {
        js: '.js',
      }
    },
  },
  // MCP Server build configuration
  {
    entry: ['src/mcp/issue-management-server.ts'],
    format: ['esm'],
    target: 'node16',
    outDir: 'dist/mcp',
    clean: false,
    sourcemap: true,
    dts: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
    outExtension() {
      return {
        js: '.js',
      }
    },
  },
  // Library build configuration
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node16',
    outDir: 'dist',
    clean: false,
    sourcemap: true,
    dts: true,
    splitting: false,
    outExtension() {
      return {
        js: '.js',
      }
    },
  },
])
