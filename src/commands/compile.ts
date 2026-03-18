import { ScriptCommandBase, ScriptCommandInput } from './script-command-base.js'
import { getPackageScripts } from '../utils/package-json.js'
import { runScript } from '../utils/package-manager.js'
import { logger } from '../utils/logger.js'

export type { ScriptCommandInput as CompileCommandInput }

/**
 * CompileCommand - Run the compile or typecheck script for a workspace
 *
 * Script priority:
 * 1. Run 'compile' if it exists
 * 2. Fall back to 'typecheck' if 'compile' doesn't exist
 * 3. Skip silently if neither exists
 *
 * Uses package.iloom.json if available, otherwise falls back to package.json
 */
export class CompileCommand extends ScriptCommandBase {
	getScriptName(): string {
		return 'compile' // Primary script name
	}

	getScriptDisplayName(): string {
		return 'Compile/Typecheck'
	}

	/**
	 * Override execute to handle compile/typecheck fallback logic
	 */
	override async execute(input: ScriptCommandInput): Promise<void> {
		// 1. Parse or auto-detect identifier
		const parsed = input.identifier
			? await this.parseExplicitInput(input.identifier)
			: await this.autoDetectFromCurrentDirectory()

		logger.debug(`Parsed input: ${JSON.stringify(parsed)}`)

		// 2. Find worktree path based on identifier
		const worktree = await this.findWorktreeForIdentifier(parsed)
		logger.info(`Found worktree at: ${worktree.path}`)

		// 3. Check for compile or typecheck script
		const scripts = await getPackageScripts(worktree.path)

		let scriptToRun: 'compile' | 'typecheck' | null = null

		if (scripts['compile']) {
			scriptToRun = 'compile'
		} else if (scripts['typecheck']) {
			scriptToRun = 'typecheck'
		}

		// 4. Skip silently if neither script exists
		if (!scriptToRun) {
			logger.info('No compile or typecheck script defined, skipping')
			return
		}

		// 5. Read packagesToValidate from loom metadata for monorepo scoping
		const packages = await this.readPackagesToValidate(worktree.path)

		if (packages.length > 0) {
			logger.info(`Scoping Compile/Typecheck to packages: ${packages.join(', ')}`)
		}

		// 6. Run the found script
		const displayName = scriptToRun === 'compile' ? 'Compile' : 'Typecheck'
		logger.info(`Running ${displayName}...`)
		await runScript(scriptToRun, worktree.path, [], { packages })
		logger.success(`${displayName} completed successfully`)
	}
}
