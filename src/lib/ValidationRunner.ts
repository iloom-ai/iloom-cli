import { getLogger } from '../utils/logger-context.js'
import { detectPackageManager, runScript } from '../utils/package-manager.js'
import { getPackageConfig, hasScript } from '../utils/package-json.js'
import { detectClaudeCli, launchClaude } from '../utils/claude.js'
import type {
	ValidationOptions,
	ValidationResult,
	ValidationStepResult,
} from '../types/index.js'

/**
 * ValidationRunner orchestrates pre-merge validation pipeline
 * Runs typecheck, lint, and tests in sequence with fail-fast behavior
 */
export class ValidationRunner {
	constructor() {
		// Uses getLogger() for all logging operations
	}

	/**
	 * Run all validations in sequence: typecheck → lint → test
	 * Fails fast on first error
	 */
	async runValidations(
		worktreePath: string,
		options: ValidationOptions = {}
	): Promise<ValidationResult> {
		const startTime = Date.now()
		const steps: ValidationStepResult[] = []

		const { jsonStream } = options

		// Run typecheck
		if (!options.skipTypecheck) {
			const typecheckResult = await this.runTypecheck(
				worktreePath,
				options.dryRun ?? false,
				{ jsonStream }
			)
			steps.push(typecheckResult)

			if (!typecheckResult.passed && !typecheckResult.skipped) {
				return {
					success: false,
					steps,
					totalDuration: Date.now() - startTime,
				}
			}
		}

		// Run lint
		if (!options.skipLint) {
			const lintResult = await this.runLint(worktreePath, options.dryRun ?? false, { jsonStream })
			steps.push(lintResult)

			if (!lintResult.passed && !lintResult.skipped) {
				return { success: false, steps, totalDuration: Date.now() - startTime }
			}
		}

		// Run tests
		if (!options.skipTests) {
			const testResult = await this.runTests(
				worktreePath,
				options.dryRun ?? false,
				{ jsonStream }
			)
			steps.push(testResult)

			if (!testResult.passed && !testResult.skipped) {
				return { success: false, steps, totalDuration: Date.now() - startTime }
			}
		}

		return { success: true, steps, totalDuration: Date.now() - startTime }
	}

	/**
	 * Run typecheck validation
	 * Prefers 'compile' script over 'typecheck' if both exist
	 */
	private async runTypecheck(
		worktreePath: string,
		dryRun: boolean,
		options: { jsonStream?: boolean | undefined } = {}
	): Promise<ValidationStepResult> {
		const stepStartTime = Date.now()

		let scriptToRun: 'compile' | 'typecheck' | null = null

		try {
			// Check for compile and typecheck scripts - prefer compile if both exist
			const pkgJson = await getPackageConfig(worktreePath)
			const hasCompileScript = hasScript(pkgJson, 'compile')
			const hasTypecheckScript = hasScript(pkgJson, 'typecheck')

			if (hasCompileScript) {
				scriptToRun = 'compile'
			} else if (hasTypecheckScript) {
				scriptToRun = 'typecheck'
			}

			if (!scriptToRun) {
				getLogger().debug('Skipping typecheck - no compile or typecheck script found')
				return {
					step: 'typecheck',
					passed: true,
					skipped: true,
					duration: Date.now() - stepStartTime,
				}
			}
		} catch (error) {
			// Handle missing package.json - skip validation for non-Node.js projects
			if (error instanceof Error && error.message.includes('package.json not found')) {
				getLogger().debug('Skipping typecheck - no package.json found (non-Node.js project)')
				return {
					step: 'typecheck',
					passed: true,
					skipped: true,
					duration: Date.now() - stepStartTime,
				}
			}
			// Re-throw other errors
			throw error
		}

		const packageManager = await detectPackageManager(worktreePath)

		if (dryRun) {
			const command =
				packageManager === 'npm'
					? `npm run ${scriptToRun}`
					: `${packageManager} ${scriptToRun}`
			getLogger().info(`[DRY RUN] Would run: ${command}`)
			return {
				step: scriptToRun,
				passed: true,
				skipped: false,
				duration: Date.now() - stepStartTime,
			}
		}

		getLogger().info(`Running ${scriptToRun}...`)

		try {
			await runScript(scriptToRun, worktreePath, [], { quiet: true })
			getLogger().success(`${scriptToRun.charAt(0).toUpperCase() + scriptToRun.slice(1)} passed`)

			return {
				step: scriptToRun,
				passed: true,
				skipped: false,
				duration: Date.now() - stepStartTime,
			}
		} catch {
			// Attempt Claude-assisted fix before failing
			const fixed = await this.attemptClaudeFix(
				scriptToRun,
				worktreePath,
				packageManager,
				{ jsonStream: options.jsonStream }
			)

			if (fixed) {
				return {
					step: scriptToRun,
					passed: true,
					skipped: false,
					duration: Date.now() - stepStartTime,
				}
			}

			// Claude couldn't fix - throw original error
			const runCommand =
				packageManager === 'npm'
					? `npm run ${scriptToRun}`
					: `${packageManager} ${scriptToRun}`

			const stepLabel = scriptToRun.charAt(0).toUpperCase() + scriptToRun.slice(1)
			throw new Error(
				`Error: ${stepLabel} failed.\n` +
					`Fix type errors before merging.\n\n` +
					`Run '${runCommand}' to see detailed errors.`
			)
		}
	}

	/**
	 * Run lint validation
	 */
	private async runLint(
		worktreePath: string,
		dryRun: boolean,
		options: { jsonStream?: boolean | undefined } = {}
	): Promise<ValidationStepResult> {
		const stepStartTime = Date.now()

		try {
			// Check if lint script exists
			const pkgJson = await getPackageConfig(worktreePath)
			const hasLintScript = hasScript(pkgJson, 'lint')

			if (!hasLintScript) {
				getLogger().debug('Skipping lint - no lint script found')
				return {
					step: 'lint',
					passed: true,
					skipped: true,
					duration: Date.now() - stepStartTime,
				}
			}
		} catch (error) {
			// Handle missing package.json - skip validation for non-Node.js projects
			if (error instanceof Error && error.message.includes('package.json not found')) {
				getLogger().debug('Skipping lint - no package.json found (non-Node.js project)')
				return {
					step: 'lint',
					passed: true,
					skipped: true,
					duration: Date.now() - stepStartTime,
				}
			}
			// Re-throw other errors
			throw error
		}

		const packageManager = await detectPackageManager(worktreePath)

		if (dryRun) {
			const command =
				packageManager === 'npm' ? 'npm run lint' : `${packageManager} lint`
			getLogger().info(`[DRY RUN] Would run: ${command}`)
			return {
				step: 'lint',
				passed: true,
				skipped: false,
				duration: Date.now() - stepStartTime,
			}
		}

		getLogger().info('Running lint...')

		try {
			await runScript('lint', worktreePath, [], { quiet: true })
			getLogger().success('Linting passed')

			return {
				step: 'lint',
				passed: true,
				skipped: false,
				duration: Date.now() - stepStartTime,
			}
		} catch {
			// Attempt Claude-assisted fix before failing
			const fixed = await this.attemptClaudeFix(
				'lint',
				worktreePath,
				packageManager,
				{ jsonStream: options.jsonStream }
			)

			if (fixed) {
				// logger.success('Linting passed after Claude auto-fix')
				return {
					step: 'lint',
					passed: true,
					skipped: false,
					duration: Date.now() - stepStartTime,
				}
			}

			// Claude couldn't fix - throw original error
			const runCommand =
				packageManager === 'npm' ? 'npm run lint' : `${packageManager} lint`

			throw new Error(
				`Error: Linting failed.\n` +
					`Fix linting errors before merging.\n\n` +
					`Run '${runCommand}' to see detailed errors.`
			)
		}
	}

	/**
	 * Run test validation
	 */
	private async runTests(
		worktreePath: string,
		dryRun: boolean,
		options: { jsonStream?: boolean | undefined } = {}
	): Promise<ValidationStepResult> {
		const stepStartTime = Date.now()

		try {
			// Check if test script exists
			const pkgJson = await getPackageConfig(worktreePath)
			const hasTestScript = hasScript(pkgJson, 'test')

			if (!hasTestScript) {
				getLogger().debug('Skipping tests - no test script found')
				return {
					step: 'test',
					passed: true,
					skipped: true,
					duration: Date.now() - stepStartTime,
				}
			}
		} catch (error) {
			// Handle missing package.json - skip validation for non-Node.js projects
			if (error instanceof Error && error.message.includes('package.json not found')) {
				getLogger().debug('Skipping tests - no package.json found (non-Node.js project)')
				return {
					step: 'test',
					passed: true,
					skipped: true,
					duration: Date.now() - stepStartTime,
				}
			}
			// Re-throw other errors
			throw error
		}

		const packageManager = await detectPackageManager(worktreePath)

		if (dryRun) {
			const command =
				packageManager === 'npm' ? 'npm run test' : `${packageManager} test`
			getLogger().info(`[DRY RUN] Would run: ${command}`)
			return {
				step: 'test',
				passed: true,
				skipped: false,
				duration: Date.now() - stepStartTime,
			}
		}

		getLogger().info('Running tests...')

		try {
			await runScript('test', worktreePath, [], { quiet: true })
			getLogger().success('Tests passed')

			return {
				step: 'test',
				passed: true,
				skipped: false,
				duration: Date.now() - stepStartTime,
			}
		} catch {
			// Attempt Claude-assisted fix before failing
			const fixed = await this.attemptClaudeFix(
				'test',
				worktreePath,
				packageManager,
				{ jsonStream: options.jsonStream }
			)

			if (fixed) {
				// logger.success('Tests passed after Claude auto-fix')
				return {
					step: 'test',
					passed: true,
					skipped: false,
					duration: Date.now() - stepStartTime,
				}
			}

			// Claude couldn't fix - throw original error
			const runCommand =
				packageManager === 'npm' ? 'npm run test' : `${packageManager} test`

			throw new Error(
				`Error: Tests failed.\n` +
					`Fix test failures before merging.\n\n` +
					`Run '${runCommand}' to see detailed errors.`
			)
		}
	}

	/**
	 * Attempt to fix validation errors using Claude
	 * Pattern based on MergeManager.attemptClaudeConflictResolution
	 *
	 * @param validationType - Type of validation that failed ('compile' | 'typecheck' | 'lint' | 'test')
	 * @param worktreePath - Path to the worktree
	 * @param packageManager - Detected package manager
	 * @returns true if Claude fixed the issue, false otherwise
	 */
	private async attemptClaudeFix(
		validationType: 'compile' | 'typecheck' | 'lint' | 'test',
		worktreePath: string,
		packageManager: string,
		options: { jsonStream?: boolean | undefined } = {}
	): Promise<boolean> {
		// Check if Claude CLI is available
		const isClaudeAvailable = await detectClaudeCli()
		if (!isClaudeAvailable) {
			getLogger().debug('Claude CLI not available, skipping auto-fix')
			return false
		}

		// Build validation command for the prompt
		const validationCommand = this.getValidationCommand(validationType, packageManager)

		// Build prompt based on validation type (matching bash script prompts)
		const prompt = this.getClaudePrompt(validationType, validationCommand)

		const validationTypeCapitalized = validationType.charAt(0).toUpperCase() + validationType.slice(1)
		getLogger().info(`Launching Claude to help fix ${validationTypeCapitalized} errors...`)

		try {
			// When jsonStream is true, run Claude headless with stdout passthrough for JSONL streaming
			// Otherwise, launch interactively in the current terminal
			await launchClaude(prompt, {
				addDir: worktreePath,
				headless: !!options.jsonStream,
				permissionMode: options.jsonStream ? 'bypassPermissions' : 'acceptEdits',
				model: 'sonnet',
				noSessionPersistence: true,
				...(options.jsonStream && { passthroughStdout: true }),
			})

			// After Claude completes, re-run validation to verify fix
			getLogger().info(`Re-running ${validationTypeCapitalized} after Claude's fixes...`)

			try {
				await runScript(validationType, worktreePath, [], { quiet: true })
				// Validation passed after Claude fix
				getLogger().success(`${validationTypeCapitalized} passed after Claude auto-fix`)
				return true
			} catch {
				// Validation still failing after Claude's attempt
				getLogger().warn(`${validationTypeCapitalized} still failing after Claude's help`)
				return false
			}
		} catch (error) {
			// Claude launch failed or crashed
			getLogger().warn('Claude auto-fix failed', {
				error: error instanceof Error ? error.message : String(error),
			})
			return false
		}
	}

	/**
	 * Get validation command string for prompts
	 * Uses il commands for multi-language project support
	 */
	private getValidationCommand(
		validationType: 'compile' | 'typecheck' | 'lint' | 'test',
		_packageManager: string
	): string {
		// Use il commands for consistent multi-language project support
		return `il ${validationType}`
	}

	/**
	 * Get Claude prompt for specific validation type
	 * Matches bash script prompts exactly
	 */
	private getClaudePrompt(
		validationType: 'compile' | 'typecheck' | 'lint' | 'test',
		validationCommand: string
	): string {
		switch (validationType) {
			case 'compile':
			case 'typecheck':
				return (
					`There are compilation errors in this codebase. ` +
					`Please analyze the ${validationType} output, identify all type errors, and fix them. ` +
					`Run '${validationCommand}' to see the errors, then make the necessary code changes to resolve all type issues. ` +
					`When you are done, tell the user to quit using /exit to continue the validation process.`
				)
			case 'lint':
				return (
					`There are Lint errors in this codebase. ` +
					`Please analyze the linting output, identify all linting issues, and fix them. ` +
					`Run '${validationCommand}' to see the errors, then make the necessary code changes to resolve all linting issues. ` +
					`Focus on code quality, consistency, and following the project's linting rules. ` +
					`When you are done, tell the user to quit using /exit to continue the validation process.`
				)
			case 'test':
				return (
					`There are unit test failures in this codebase. ` +
					`Please analyze the test output to understand what's failing, then fix the issues. ` +
					`This might involve updating test code, fixing bugs in the source code, or updating tests to match new behavior. ` +
					`Run '${validationCommand}' to see the detailed test failures, then make the necessary changes to get all tests passing. ` +
					`When you are done, tell the user to quit using /exit to continue the validation process.`
				)
		}
	}
}
