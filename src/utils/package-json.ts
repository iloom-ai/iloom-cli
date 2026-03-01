import fs from 'fs-extra'
import path from 'path'
import { z } from 'zod'
import { getLogger } from './logger-context.js'
import type { ProjectCapability } from '../types/loom.js'

/**
 * Path to the iloom package configuration file (relative to project root)
 * This file allows non-Node.js projects to define scripts for iloom workflows
 */
export const ILOOM_PACKAGE_PATH = '.iloom/package.iloom.json'
export const ILOOM_PACKAGE_LOCAL_PATH = '.iloom/package.iloom.local.json'

/**
 * Zod schema for package.iloom.json / package.iloom.local.json
 * Defines project capabilities and custom shell commands for non-Node.js projects
 */
export const PackageIloomSchema = z.object({
  capabilities: z.array(z.enum(['cli', 'web'])).optional()
    .describe('Project capabilities - "cli" for command-line tools (enables CLI isolation), "web" for web applications (enables port assignment and dev server)'),
  scripts: z.object({
    install: z.string().optional().describe('Install command (e.g., "bundle install", "poetry install")'),
    build: z.string().optional().describe('Build/compile command'),
    test: z.string().optional().describe('Test suite command'),
    dev: z.string().optional().describe('Dev server command'),
    lint: z.string().optional().describe('Linting command'),
    typecheck: z.string().optional().describe('Type checking command'),
    compile: z.string().optional().describe('Compilation command (preferred over typecheck if both exist)'),
  }).optional().describe('Custom shell commands for project operations. These are raw shell commands, not npm script names.'),
})

export interface PackageJson {
  name: string
  version?: string
  bin?: string | Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
  capabilities?: ProjectCapability[]
  [key: string]: unknown
}

/**
 * Source of a script - determines how it should be executed
 * - 'package-manager': Execute via package manager (pnpm/npm/yarn)
 * - 'iloom-config': Execute directly as shell command
 */
export type ScriptSource = 'package-manager' | 'iloom-config'

/**
 * Configuration for a single script including its source
 * The source determines whether to use package manager or direct shell execution
 */
export interface PackageScriptConfig {
  /** The script command to execute */
  command: string
  /** Source of the script - determines execution method */
  source: ScriptSource
}

/**
 * Read and parse package.json from a directory
 * @param dir Directory containing package.json
 * @returns Parsed package.json object
 * @throws Error if package.json doesn't exist or contains invalid JSON
 */
export async function readPackageJson(dir: string): Promise<PackageJson> {
  const pkgPath = path.join(dir, 'package.json')

  try {
    const pkgJson = await fs.readJson(pkgPath)
    return pkgJson as PackageJson
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new Error(`package.json not found in ${dir}`)
    }
    const message = error instanceof Error ? error.message : 'Unknown error'
    throw new Error(`Invalid package.json in ${dir}: ${message}`)
  }
}

/**
 * Read scripts from .iloom/package.iloom.json if it exists, merged with
 * .iloom/package.iloom.local.json (local takes precedence).
 * These files take precedence over package.json and contain raw shell commands.
 * @param dir Directory containing .iloom/package.iloom.json
 * @returns PackageJson-like object with scripts, or null if neither file exists
 */
export async function readIloomPackageScripts(dir: string): Promise<PackageJson | null> {
  const iloomPkgPath = path.join(dir, ILOOM_PACKAGE_PATH)
  const localPkgPath = path.join(dir, ILOOM_PACKAGE_LOCAL_PATH)

  // Read base package.iloom.json
  let baseConfig: PackageJson | null = null
  try {
    const exists = await fs.pathExists(iloomPkgPath)
    if (exists) {
      baseConfig = await fs.readJson(iloomPkgPath) as PackageJson
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    getLogger().warn(`Failed to read ${ILOOM_PACKAGE_PATH}: ${message}`)
  }

  // Read local override if exists
  let localConfig: PackageJson | null = null
  try {
    const localExists = await fs.pathExists(localPkgPath)
    if (localExists) {
      localConfig = await fs.readJson(localPkgPath) as PackageJson
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    getLogger().warn(`Failed to read ${ILOOM_PACKAGE_LOCAL_PATH}: ${message}`)
  }

  // Merge: local scripts override base scripts
  if (baseConfig && localConfig) {
    return {
      ...baseConfig,
      scripts: { ...baseConfig.scripts, ...localConfig.scripts },
      ...(localConfig.capabilities && { capabilities: localConfig.capabilities }),
    }
  }

  // Return whichever exists (or null if neither)
  return localConfig ?? baseConfig
}

/**
 * Read package configuration for a project, merging .iloom/package.iloom.json scripts over package.json
 * This allows non-Node.js projects to define scripts for iloom workflows while preserving
 * all other package.json fields (name, version, bin, dependencies, etc.)
 *
 * @param dir Directory to read package configuration from
 * @returns PackageJson object with merged scripts (iloom scripts take precedence)
 * @throws Error if neither file exists or contains valid JSON
 */
export async function getPackageConfig(dir: string): Promise<PackageJson> {
  // Check for .iloom/package.iloom.json first
  const iloomPackage = await readIloomPackageScripts(dir)

  if (iloomPackage) {
    // Try to read package.json as base
    try {
      const basePackage = await readPackageJson(dir)
      getLogger().debug('Merging scripts from .iloom/package.iloom.json over package.json')
      // Merge: base package.json with iloom scripts taking precedence
      return {
        ...basePackage,
        scripts: {
          ...basePackage.scripts,
          ...iloomPackage.scripts,
        },
      }
    } catch {
      // No package.json - use iloom package as-is (non-Node project)
      getLogger().debug('Using scripts from .iloom/package.iloom.json (no package.json)')
      return iloomPackage
    }
  }

  // Fall back to package.json only
  return readPackageJson(dir)
}

/**
 * Parse bin field into normalized Record format
 * @param bin The bin field from package.json (string or object)
 * @param packageName Package name to use for string bin variant
 * @returns Normalized bin entries as Record<string, string>
 */
export function parseBinField(
  bin: string | Record<string, string> | undefined,
  packageName: string
): Record<string, string> {
  if (!bin) {
    return {}
  }

  if (typeof bin === 'string') {
    return { [packageName]: bin }
  }

  return bin
}

/**
 * Check if package.json indicates a web application
 * @param pkgJson Parsed package.json object
 * @returns true if package has web framework dependencies
 */
export function hasWebDependencies(pkgJson: PackageJson): boolean {
  const webIndicators = [
    'next',
    'vite',
    'express',
    'react-scripts',
    'nuxt',
    'svelte-kit',
    'astro',
    'remix',
    'fastify',
    'koa',
    'hapi',
    '@angular/core',
    'gatsby',
    '@11ty/eleventy',
    'ember-cli'
  ]

  const allDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies
  }

  return webIndicators.some(indicator => indicator in allDeps)
}

/**
 * Check if package.json has a specific script
 * @param pkgJson Parsed package.json object
 * @param scriptName Script name to check for
 * @returns true if script exists
 */
export function hasScript(pkgJson: PackageJson, scriptName: string): boolean {
  return !!pkgJson.scripts?.[scriptName]
}

/**
 * Get all scripts with their source metadata
 * Scripts from .iloom/package.iloom.json are marked as 'iloom-config' and should be executed directly
 * Scripts from package.json are marked as 'package-manager' and should use pnpm/npm/yarn
 *
 * @param dir Directory to read package configuration from
 * @returns Map of script names to their configurations including source
 */
export async function getPackageScripts(dir: string): Promise<Record<string, PackageScriptConfig>> {
  const scripts: Record<string, PackageScriptConfig> = {}

  // First, check if package.json exists and read scripts (these are package-manager sourced)
  const packageJsonPath = path.join(dir, 'package.json')
  if (await fs.pathExists(packageJsonPath)) {
    const pkgJson = await readPackageJson(dir)
    if (pkgJson.scripts) {
      for (const [name, command] of Object.entries(pkgJson.scripts)) {
        scripts[name] = { command, source: 'package-manager' }
      }
    }
  }

  // Then, read iloom package scripts (these override and are iloom-config sourced)
  const iloomPackage = await readIloomPackageScripts(dir)
  if (iloomPackage?.scripts) {
    for (const [name, command] of Object.entries(iloomPackage.scripts)) {
      scripts[name] = { command, source: 'iloom-config' }
    }
  }

  return scripts
}

/**
 * Valid capability values that can be explicitly declared
 */
const VALID_CAPABILITIES: readonly ProjectCapability[] = ['cli', 'web'] as const

/**
 * Extract explicit capabilities from package configuration
 * Used for non-Node.js projects that declare capabilities in package.iloom.json
 * @param pkgJson Parsed package configuration object
 * @returns Array of valid ProjectCapability values, or empty array if none declared
 */
export function getExplicitCapabilities(pkgJson: PackageJson): ProjectCapability[] {
  // Return empty if no capabilities field or not an array
  if (!pkgJson.capabilities || !Array.isArray(pkgJson.capabilities)) {
    return []
  }

  // Filter to only valid ProjectCapability values
  return pkgJson.capabilities.filter(
    (cap): cap is ProjectCapability => VALID_CAPABILITIES.includes(cap as ProjectCapability)
  )
}
