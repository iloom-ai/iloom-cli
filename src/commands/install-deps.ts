import { ScriptCommandBase, ScriptCommandInput } from './script-command-base.js'
import { installDependencies } from '../utils/package-manager.js'
import { logger } from '../utils/logger.js'

export interface InstallDepsCommandInput extends ScriptCommandInput {
	frozen?: boolean | undefined
}

/**
 * InstallDepsCommand - Install dependencies for a workspace
 *
 * Unlike other script commands that use runScript(), this command delegates to
 * installDependencies() which includes Node.js lockfile detection fallback
 * when no explicit install script is defined.
 *
 * Install resolution order:
 * 1. scripts.install in .iloom/package.iloom.local.json (highest priority)
 * 2. scripts.install in .iloom/package.iloom.json
 * 3. scripts.install in package.json
 * 4. Node.js lockfile detection (pnpm/npm/yarn with frozen lockfile)
 * 5. Silently skips if no install mechanism found
 */
export class InstallDepsCommand extends ScriptCommandBase {
	getScriptName(): string {
		return 'install'
	}

	getScriptDisplayName(): string {
		return 'Install Dependencies'
	}

	/**
	 * Override execute to use installDependencies() instead of runScript()
	 * This provides the full install resolution chain including Node.js lockfile fallback
	 */
	override async execute(input: InstallDepsCommandInput): Promise<void> {
		// 1. Parse or auto-detect identifier
		const parsed = input.identifier
			? await this.parseExplicitInput(input.identifier)
			: await this.autoDetectFromCurrentDirectory()

		logger.debug(`Parsed input: ${JSON.stringify(parsed)}`)

		// 2. Find worktree path based on identifier
		const worktree = await this.findWorktreeForIdentifier(parsed)
		logger.info(`Found worktree at: ${worktree.path}`)

		// 3. Run installDependencies (handles iloom config scripts, package.json scripts,
		//    AND Node.js lockfile fallback -- unlike base class which only does runScript)
		const frozen = input.frozen !== false // default true
		await installDependencies(worktree.path, frozen, false) // quiet=false for CLI
	}
}
