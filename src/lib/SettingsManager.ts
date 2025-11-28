import { readFile } from 'fs/promises'
import path from 'path'
import { z } from 'zod'
import deepmerge from 'deepmerge'
import { logger } from '../utils/logger.js'

/**
 * Zod schema for agent settings
 */
export const AgentSettingsSchema = z.object({
	model: z
		.enum(['sonnet', 'opus', 'haiku'])
		.optional()
		.describe('Claude model shorthand: sonnet, opus, or haiku'),
	// Future: could add other per-agent overrides
})

/**
 * Zod schema for workflow permission configuration
 */
export const WorkflowPermissionSchema = z.object({
	permissionMode: z
		.enum(['plan', 'acceptEdits', 'bypassPermissions', 'default'])
		.optional()
		.describe('Permission mode for Claude CLI in this workflow type'),
	noVerify: z
		.boolean()
		.optional()
		.describe('Skip pre-commit hooks (--no-verify) when committing during finish workflow'),
	startIde: z
		.boolean()
		.default(true)
		.describe('Launch IDE (code) when starting this workflow type'),
	startDevServer: z
		.boolean()
		.default(true)
		.describe('Launch development server when starting this workflow type'),
	startAiAgent: z
		.boolean()
		.default(true)
		.describe('Launch Claude AI agent when starting this workflow type'),
	startTerminal: z
		.boolean()
		.default(false)
		.describe('Launch terminal window without dev server when starting this workflow type'),
})

/**
 * Zod schema for workflows settings
 */
export const WorkflowsSettingsSchema = z
	.object({
		issue: WorkflowPermissionSchema.optional(),
		pr: WorkflowPermissionSchema.optional(),
		regular: WorkflowPermissionSchema.optional(),
	})
	.optional()

/**
 * Zod schema for capabilities settings
 */
export const CapabilitiesSettingsSchema = z
	.object({
		web: z
			.object({
				basePort: z
					.number()
					.min(1, 'Base port must be >= 1')
					.max(65535, 'Base port must be <= 65535')
					.optional()
					.describe('Base port for web workspace port calculations (default: 3000)'),
			})
			.optional(),
		database: z
			.object({
				databaseUrlEnvVarName: z
					.string()
					.min(1, 'Database URL variable name cannot be empty')
					.regex(/^[A-Z_][A-Z0-9_]*$/, 'Must be valid env var name (uppercase, underscores)')
					.optional()
					.default('DATABASE_URL')
					.describe('Name of environment variable for database connection URL'),
			})
			.optional(),
	})
	.optional()

/**
 * Zod schema for Neon database provider settings
 */
export const NeonSettingsSchema = z.object({
	projectId: z
		.string()
		.min(1)
		.regex(/^[a-zA-Z0-9-]+$/, 'Neon project ID must contain only letters, numbers, and hyphens')
		.describe('Neon project ID found in your project URL (e.g., "fantastic-fox-3566354")'),
	parentBranch: z
		.string()
		.min(1)
		.describe('Branch from which new database branches are created'),
})

/**
 * Zod schema for database provider settings
 */
export const DatabaseProvidersSettingsSchema = z
	.object({
		neon: NeonSettingsSchema.optional().describe(
			'Neon database configuration. Requires Neon CLI installed and authenticated for database branching.',
		),
	})
	.optional()

/**
 * Zod schema for iloom settings
 */
export const IloomSettingsSchema = z.object({
	mainBranch: z
		.string()
		.min(1, "Settings 'mainBranch' cannot be empty")
		.optional()
		.describe('Name of the main/primary branch for the repository'),
	worktreePrefix: z
		.string()
		.optional()
		.refine(
			(val) => {
				if (val === undefined) return true // undefined = use default calculation
				if (val === '') return true // empty string = no prefix mode

				// Allowlist: only alphanumeric, hyphens, underscores, and forward slashes
				const allowedChars = /^[a-zA-Z0-9\-_/]+$/
				if (!allowedChars.test(val)) return false

				// Reject if only special characters (no alphanumeric content)
				if (/^[-_/]+$/.test(val)) return false

				// Check each segment (split by /) contains at least one alphanumeric character
				const segments = val.split('/')
				for (const segment of segments) {
					if (segment && /^[-_]+$/.test(segment)) {
						// Segment exists but contains only hyphens/underscores
						return false
					}
				}

				return true
			},
			{
				message:
					"worktreePrefix contains invalid characters. Only alphanumeric characters, hyphens (-), underscores (_), and forward slashes (/) are allowed. Use forward slashes for nested directories.",
			},
		)
		.describe(
			'Prefix for worktree directories. Empty string disables prefix. Defaults to <repo-name>-looms if not set.',
		),
	protectedBranches: z
		.array(z.string().min(1, 'Protected branch name cannot be empty'))
		.optional()
		.describe('List of branches that cannot be deleted (defaults to [mainBranch, "main", "master", "develop"])'),
	workflows: WorkflowsSettingsSchema.describe('Per-workflow-type permission configurations'),
	agents: z
		.record(z.string(), AgentSettingsSchema)
		.optional()
		.nullable()
		.describe(
			'Per-agent configuration overrides. Available agents: ' +
				'iloom-issue-analyzer (analyzes issues), ' +
				'iloom-issue-planner (creates implementation plans), ' +
				'iloom-issue-analyze-and-plan (combined analysis and planning), ' +
				'iloom-issue-complexity-evaluator (evaluates complexity), ' +
				'iloom-issue-enhancer (enhances issue descriptions), ' +
				'iloom-issue-implementer (implements code changes), ' +
				'iloom-issue-reviewer (reviews code changes against requirements)',
		),
	capabilities: CapabilitiesSettingsSchema.describe('Project capability configurations'),
	databaseProviders: DatabaseProvidersSettingsSchema.describe('Database provider configurations'),
})

/**
 * TypeScript type for Neon settings derived from Zod schema
 */
export type NeonSettings = z.infer<typeof NeonSettingsSchema>

/**
 * TypeScript type for database providers settings derived from Zod schema
 */
export type DatabaseProvidersSettings = z.infer<typeof DatabaseProvidersSettingsSchema>

/**
 * TypeScript type for agent settings derived from Zod schema
 */
export type AgentSettings = z.infer<typeof AgentSettingsSchema>

/**
 * TypeScript type for workflow permission configuration derived from Zod schema
 */
export type WorkflowPermission = z.infer<typeof WorkflowPermissionSchema>

/**
 * TypeScript type for workflows settings derived from Zod schema
 */
export type WorkflowsSettings = z.infer<typeof WorkflowsSettingsSchema>

/**
 * TypeScript type for capabilities settings derived from Zod schema
 */
export type CapabilitiesSettings = z.infer<typeof CapabilitiesSettingsSchema>

/**
 * TypeScript type for iloom settings derived from Zod schema
 */
export type IloomSettings = z.infer<typeof IloomSettingsSchema>

/**
 * Manages project-level settings from .iloom/settings.json
 */
export class SettingsManager {
	/**
	 * Load settings from <PROJECT_ROOT>/.iloom/settings.json and settings.local.json
	 * Merges settings.local.json over settings.json with priority
	 * CLI overrides have highest priority if provided
	 * Returns empty object if both files don't exist (not an error)
	 */
	async loadSettings(
		projectRoot?: string,
		cliOverrides?: Partial<IloomSettings>,
	): Promise<IloomSettings> {
		const root = this.getProjectRoot(projectRoot)

		// Load base settings from settings.json
		const baseSettings = await this.loadSettingsFile(root, 'settings.json')
		const baseSettingsPath = path.join(root, '.iloom', 'settings.json')
		logger.debug(`📄 Base settings from ${baseSettingsPath}:`, JSON.stringify(baseSettings, null, 2))

		// Load local overrides from settings.local.json
		const localSettings = await this.loadSettingsFile(root, 'settings.local.json')
		const localSettingsPath = path.join(root, '.iloom', 'settings.local.json')
		logger.debug(`📄 Local settings from ${localSettingsPath}:`, JSON.stringify(localSettings, null, 2))

		// Deep merge with priority: cliOverrides > localSettings > baseSettings
		let merged = this.mergeSettings(baseSettings, localSettings)
		logger.debug('🔄 After merging base + local settings:', JSON.stringify(merged, null, 2))

		if (cliOverrides && Object.keys(cliOverrides).length > 0) {
			logger.debug('⚙️ CLI overrides to apply:', JSON.stringify(cliOverrides, null, 2))
			merged = this.mergeSettings(merged, cliOverrides)
			logger.debug('🔄 After applying CLI overrides:', JSON.stringify(merged, null, 2))
		}

		// Validate merged result
		try {
			const finalSettings = IloomSettingsSchema.parse(merged)

			// Debug: Log final merged configuration
			this.logFinalConfiguration(finalSettings)

			return finalSettings
		} catch (error) {
			// Show all Zod validation errors
			if (error instanceof z.ZodError) {
				const errorMsg = this.formatAllZodErrors(error, '<merged settings>')
				// Enhance error message if CLI overrides were applied
				if (cliOverrides && Object.keys(cliOverrides).length > 0) {
					throw new Error(`${errorMsg.message}\n\nNote: CLI overrides were applied. Check your --set arguments.`)
				}
				throw errorMsg
			}
			throw error
		}
	}

	/**
	 * Log the final merged configuration for debugging
	 */
	private logFinalConfiguration(settings: IloomSettings): void {
		logger.debug('📋 Final merged configuration:', JSON.stringify(settings, null, 2))
	}

	/**
	 * Load and parse a single settings file
	 * Returns empty object if file doesn't exist (not an error)
	 */
	private async loadSettingsFile(
		projectRoot: string,
		filename: string,
	): Promise<Partial<IloomSettings>> {
		const settingsPath = path.join(projectRoot, '.iloom', filename)

		try {
			const content = await readFile(settingsPath, 'utf-8')
			let parsed: unknown

			try {
				parsed = JSON.parse(content)
			} catch (error) {
				throw new Error(
					`Failed to parse settings file at ${settingsPath}: ${error instanceof Error ? error.message : 'Invalid JSON'}`,
				)
			}

			// Validate individual file with strict mode to catch unknown keys
			// Note: Schema already has all fields as optional, so no need for .partial()
			try {
				const validated = IloomSettingsSchema.strict().parse(parsed)
				return validated
			} catch (error) {
				if (error instanceof z.ZodError) {
					const errorMsg = this.formatAllZodErrors(error, filename)
					throw errorMsg
				}
				throw error
			}
		} catch (error) {
			// File not found is not an error - return empty settings
			if ((error as { code?: string }).code === 'ENOENT') {
				logger.debug(`No settings file found at ${settingsPath}, using defaults`)
				return {}
			}

			// Re-throw parsing errors
			throw error
		}
	}

	/**
	 * Deep merge two settings objects with priority to override
	 * Uses deepmerge library with array replacement strategy
	 */
	private mergeSettings(
		base: Partial<IloomSettings>,
		override: Partial<IloomSettings>,
	): IloomSettings {
		// Use deepmerge with array replacement (not concatenation)
		return deepmerge(base, override, {
			// Replace arrays instead of concatenating them
			arrayMerge: (_destinationArray, sourceArray) => sourceArray,
		}) as IloomSettings
	}

	/**
	 * Format all Zod validation errors into a single error message
	 */
	private formatAllZodErrors(error: z.ZodError, settingsPath: string): Error {
		const errorMessages = error.issues.map(issue => {
			const path = issue.path.length > 0 ? issue.path.join('.') : 'root'
			return `  - ${path}: ${issue.message}`
		})

		return new Error(
			`Settings validation failed at ${settingsPath}:\n${errorMessages.join('\n')}`,
		)
	}

	/**
	 * Validate settings structure and model names using Zod schema
	 * This method is kept for testing purposes but uses Zod internally
	 * @internal - Only used in tests via bracket notation
	 */
	// @ts-expect-error - Used in tests via bracket notation, TypeScript can't detect this usage
	private validateSettings(settings: IloomSettings): void {
		try {
			IloomSettingsSchema.parse(settings)
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw this.formatAllZodErrors(error, '<validation>')
			}
			throw error
		}
	}

	/**
	 * Get project root (defaults to process.cwd())
	 */
	private getProjectRoot(projectRoot?: string): string {
		return projectRoot ?? process.cwd()
	}

	/**
	 * Get effective protected branches list with mainBranch always included
	 *
	 * This method provides a single source of truth for protected branches logic:
	 * 1. Use configured protectedBranches if provided
	 * 2. Otherwise use defaults: [mainBranch, 'main', 'master', 'develop']
	 * 3. ALWAYS ensure mainBranch is included even if user configured custom list
	 *
	 * @param projectRoot - Optional project root directory (defaults to process.cwd())
	 * @returns Array of protected branch names with mainBranch guaranteed to be included
	 */
	async getProtectedBranches(projectRoot?: string): Promise<string[]> {
		const settings = await this.loadSettings(projectRoot)
		const mainBranch = settings.mainBranch ?? 'main'

		// Build protected branches list:
		// 1. Use configured protectedBranches if provided
		// 2. Otherwise use defaults: [mainBranch, 'main', 'master', 'develop']
		// 3. ALWAYS ensure mainBranch is included even if user configured custom list
		let protectedBranches: string[]
		if (settings.protectedBranches) {
			// Use configured list but ensure mainBranch is always included
			protectedBranches = settings.protectedBranches.includes(mainBranch)
				? settings.protectedBranches
				: [mainBranch, ...settings.protectedBranches]
		} else {
			// Use defaults with current mainBranch
			protectedBranches = [mainBranch, 'main', 'master', 'develop']
		}

		return protectedBranches
	}
}
