import { defineConfig } from 'tsup'

// Generate source maps only in development for debugging
// In production, omit them to reduce bundle size and avoid exposing source code
const isDevelopment = process.env['NODE_ENV'] === 'development'

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
  // Remote daemon runner - standalone process for forking
  // Source maps are conditional on NODE_ENV to avoid exposing source in production
  {
    entry: ['src/lib/RemoteDaemonRunner.ts'],
    format: ['esm'],
    target: 'node16',
    outDir: 'dist/lib',
    clean: false,
    sourcemap: isDevelopment,
    dts: false,
    splitting: false,
    // No banner - this is forked, not executed directly by user
    outExtension() {
      return {
        js: '.js',
      }
    },
  },
  // MCP Server build configuration
  {
    entry: ['src/mcp/issue-management-server.ts', 'src/mcp/recap-server.ts'],
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
