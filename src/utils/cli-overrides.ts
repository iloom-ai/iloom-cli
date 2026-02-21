import { resolve } from 'node:path'
import type { IloomSettings } from '../lib/SettingsManager.js'

/**
 * Type for parsed CLI overrides (partial settings)
 */
export type CliOverrides = Partial<IloomSettings>

/**
 * Parse CLI value string to appropriate type
 * - "true"/"false" -> boolean
 * - Numeric strings -> number
 * - Otherwise -> string
 */
export function parseCliValue(value: string): string | number | boolean {
	// Handle boolean values
	if (value === 'true') return true
	if (value === 'false') return false

	// Handle numeric values
	if (/^-?\d+$/.test(value)) {
		return parseInt(value, 10)
	}
	if (/^-?\d+\.\d+$/.test(value)) {
		return parseFloat(value)
	}

	// Default: return as string
	return value
}

/**
 * Parse dot notation key=value into nested object
 * Example: "workflows.issue.startIde=false" -> { workflows: { issue: { startIde: false } } }
 */
export function parseDotNotation(key: string, value: string): Record<string, unknown> {
	if (!key || key.trim() === '') {
		throw new Error('CLI override key cannot be empty')
	}

	const parts = key.split('.')
	const parsedValue = parseCliValue(value)

	// Build nested object from bottom up
	let result: Record<string, unknown> = {}
	let current = result

	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]
		if (!part || part.trim() === '') {
			throw new Error(`Invalid key format: "${key}" - empty segment found`)
		}
		current[part] = {}
		current = current[part] as Record<string, unknown>
	}

	// Set the final value
	const lastPart = parts[parts.length - 1]
	if (!lastPart || lastPart.trim() === '') {
		throw new Error(`Invalid key format: "${key}" - empty segment found`)
	}
	current[lastPart] = parsedValue

	return result
}

/**
 * Deep merge helper for nested objects
 * Used internally for merging multiple --set arguments
 * Arrays are replaced, not concatenated
 */
function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...target }

	for (const key in source) {
		const sourceValue = source[key]
		const targetValue = result[key]

		if (
			sourceValue &&
			typeof sourceValue === 'object' &&
			!Array.isArray(sourceValue) &&
			targetValue &&
			typeof targetValue === 'object' &&
			!Array.isArray(targetValue)
		) {
			// Both are objects - recursively merge
			result[key] = deepMerge(targetValue as Record<string, unknown>, sourceValue as Record<string, unknown>)
		} else {
			// Replace value (including arrays)
			result[key] = sourceValue
		}
	}

	return result
}

/**
 * Extract all --set arguments from process.argv
 * Returns merged partial settings object
 *
 * Supports both formats:
 * - --set key=value
 * - --set=key=value
 */
export function extractSettingsOverrides(argv: string[] = process.argv): CliOverrides {
	let result: Record<string, unknown> = {}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (!arg) continue // Skip undefined/empty entries (shouldn't happen but satisfies TypeScript)

		// Handle --set key=value format
		if (arg === '--set') {
			const nextArg = argv[i + 1]
			if (!nextArg) {
				throw new Error('--set requires a key=value argument')
			}

			// Parse key=value
			const equalsIndex = nextArg.indexOf('=')
			if (equalsIndex === -1) {
				throw new Error(`Invalid --set format: "${nextArg}". Expected key=value`)
			}

			const key = nextArg.substring(0, equalsIndex)
			const value = nextArg.substring(equalsIndex + 1)

			if (!key) {
				throw new Error(`Invalid --set format: "${nextArg}". Key cannot be empty`)
			}

			try {
				const parsed = parseDotNotation(key, value)
				result = deepMerge(result, parsed)
			} catch (error) {
				if (error instanceof Error) {
					throw new Error(`Failed to parse --set ${nextArg}: ${error.message}`)
				}
				throw error
			}

			i++ // Skip the next argument since we consumed it
		}
		// Handle --set=key=value format
		else if (arg.startsWith('--set=')) {
			const keyValue = arg.substring(6) // Remove "--set="

			// Parse key=value
			const equalsIndex = keyValue.indexOf('=')
			if (equalsIndex === -1) {
				throw new Error(`Invalid --set format: "${arg}". Expected --set=key=value`)
			}

			const key = keyValue.substring(0, equalsIndex)
			const value = keyValue.substring(equalsIndex + 1)

			if (!key) {
				throw new Error(`Invalid --set format: "${arg}". Key cannot be empty`)
			}

			try {
				const parsed = parseDotNotation(key, value)
				result = deepMerge(result, parsed)
			} catch (error) {
				if (error instanceof Error) {
					throw new Error(`Failed to parse ${arg}: ${error.message}`)
				}
				throw error
			}
		}
	}

	return result as CliOverrides
}

/**
 * Get the executable path used to invoke this CLI
 *
 * Rules:
 * - If process.argv[1] contains "/" (path), resolve to absolute path
 * - If process.argv[1] is just a name (no "/"), return as-is (in PATH)
 * - Fallback to 'il' if process.argv[1] is undefined
 *
 * Examples:
 * - ./dist/cli.js → /full/path/to/dist/cli.js
 * - dist/cli.js → /full/path/to/dist/cli.js
 * - /usr/local/bin/il → /usr/local/bin/il
 * - il → il
 * - il-125 → il-125
 */
export function getExecutablePath(): string {
	const argv1 = process.argv[1]

	if (!argv1 || argv1.trim() === '') {
		// Fallback if process.argv[1] is undefined or empty
		return 'il'
	}

	// If path contains "/", it's a file path - resolve to absolute
	if (argv1.includes('/')) {
		return resolve(argv1)
	}

	// Otherwise, it's a binary name in PATH - use as-is
	return argv1
}
