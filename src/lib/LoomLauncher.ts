import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openTerminalWindow, openMultipleTerminalWindows } from '../utils/terminal.js'
import type { TerminalWindowOptions } from '../utils/terminal.js'
import { openIdeWindow } from '../utils/ide.js'
import { generateColorFromBranchName, hexToRgb } from '../utils/color.js'
import { getLogger } from '../utils/logger-context.js'
import { ClaudeContextManager } from './ClaudeContextManager.js'
import type { SettingsManager } from './SettingsManager.js'
import type { Capability } from '../types/loom.js'
import { getDotenvFlowFiles } from '../utils/env.js'
import { getExecutablePath } from '../utils/cli-overrides.js'

export interface LaunchLoomOptions {
	enableClaude: boolean
	enableCode: boolean
	enableDevServer: boolean
	enableTerminal: boolean
	worktreePath: string
	branchName: string
	port?: number
	capabilities: Capability[]
	workflowType: 'issue' | 'pr' | 'regular'
	identifier: string | number
	title?: string
	oneShot?: import('../types/index.js').OneShotMode
	setArguments?: string[] // Raw --set arguments to forward
	executablePath?: string // Executable path to use for spin command
	sourceEnvOnStart?: boolean // defaults to false if undefined
	colorTerminal?: boolean // defaults to true if undefined
	colorHex?: string // Pre-calculated hex color from metadata, avoids recalculation
	complexity?: import('../types/index.js').ComplexityOverride
}

/**
 * LoomLauncher orchestrates opening loom components
 */
export class LoomLauncher {
	private claudeContext: ClaudeContextManager
	private settings?: SettingsManager

	constructor(claudeContext?: ClaudeContextManager, settings?: SettingsManager) {
		this.claudeContext = claudeContext ?? new ClaudeContextManager()
		if (settings !== undefined) {
			this.settings = settings
		}
	}

	/**
	 * Launch loom components based on individual flags
	 */
	async launchLoom(options: LaunchLoomOptions): Promise<void> {
		const { enableClaude, enableCode, enableDevServer, enableTerminal } = options

		getLogger().debug(`Launching loom components: Claude=${enableClaude}, Code=${enableCode}, DevServer=${enableDevServer}, Terminal=${enableTerminal}`)

		const launchPromises: Promise<void>[] = []

		// Launch VSCode if enabled
		if (enableCode) {
			getLogger().debug('Launching VSCode')
			launchPromises.push(this.launchVSCode(options))
		}

		// Build array of terminals to launch
		const terminalsToLaunch: Array<{
			type: 'claude' | 'devServer' | 'terminal'
			options: TerminalWindowOptions
		}> = []

		if (enableDevServer) {
			terminalsToLaunch.push({
				type: 'devServer',
				options: this.buildDevServerTerminalOptions(options),
			})
		}

		if (enableTerminal) {
			terminalsToLaunch.push({
				type: 'terminal',
				options: this.buildStandaloneTerminalOptions(options),
			})
		}

		if (enableClaude) {
			terminalsToLaunch.push({
				type: 'claude',
				options: await this.buildClaudeTerminalOptions(options),
			})
		}

		// Launch terminals based on count
		if (terminalsToLaunch.length > 1) {
			// Multiple terminals - launch as tabs in single window
			getLogger().debug(`Launching ${terminalsToLaunch.length} terminals in single window`)
			launchPromises.push(this.launchMultipleTerminals(terminalsToLaunch, options))
		} else if (terminalsToLaunch.length === 1) {
			// Single terminal - launch standalone
			const terminal = terminalsToLaunch[0]
			if (!terminal) {
				throw new Error('Terminal configuration is undefined')
			}
			const terminalType = terminal.type
			getLogger().debug(`Launching single ${terminalType} terminal`)

			if (terminalType === 'claude') {
				launchPromises.push(this.launchClaudeTerminal(options))
			} else if (terminalType === 'devServer') {
				launchPromises.push(this.launchDevServerTerminal(options))
			} else {
				launchPromises.push(this.launchStandaloneTerminal(options))
			}
		}

		// Wait for all components to launch
		await Promise.all(launchPromises)

		getLogger().success('loom launched successfully')
	}

	/**
	 * Launch IDE (VSCode or configured alternative)
	 */
	private async launchVSCode(options: LaunchLoomOptions): Promise<void> {
		const ideConfig = await this.settings?.loadSettings().then((s) => s.ide)
		await openIdeWindow(options.worktreePath, ideConfig)
		getLogger().info('IDE opened')
	}

	/**
	 * Launch Claude terminal
	 */
	private async launchClaudeTerminal(options: LaunchLoomOptions): Promise<void> {
		await this.claudeContext.launchWithContext({
			workspacePath: options.worktreePath,
			type: options.workflowType,
			identifier: options.identifier,
			branchName: options.branchName,
			...(options.title && { title: options.title }),
			...(options.port !== undefined && { port: options.port }),
			oneShot: options.oneShot ?? 'default',
			...(options.setArguments && { setArguments: options.setArguments }),
			...(options.executablePath && { executablePath: options.executablePath }),
		})
		getLogger().info('Claude terminal opened')
	}

	/**
	 * Launch dev server terminal
	 * Runs `il dev-server [identifier]` which handles env loading internally
	 */
	private async launchDevServerTerminal(options: LaunchLoomOptions): Promise<void> {
		// Build dev-server command with identifier
		const executable = options.executablePath ?? getExecutablePath()
		const devServerIdentifier = String(options.identifier)
		const devServerCommand = `${executable} dev-server ${devServerIdentifier}`

		// Only generate color if terminal coloring is enabled (default: true)
		const backgroundColor = (options.colorTerminal ?? true)
			? options.colorHex
				? hexToRgb(options.colorHex)
				: generateColorFromBranchName(options.branchName).rgb
			: undefined

		await openTerminalWindow({
			workspacePath: options.worktreePath,
			command: devServerCommand,
			...(backgroundColor && { backgroundColor }),
			// il dev-server handles env loading internally, so no includeEnvSetup
			includeEnvSetup: false,
			includePortExport: options.capabilities.includes('web'),
			...(options.port !== undefined && { port: options.port }),
		})
		getLogger().info('Dev server terminal opened')
	}

	/**
	 * Launch standalone terminal running `il shell <identifier>`
	 */
	private async launchStandaloneTerminal(options: LaunchLoomOptions): Promise<void> {
		// Build shell command with identifier
		const executable = options.executablePath ?? getExecutablePath()
		const shellIdentifier = String(options.identifier)
		const shellCommand = `${executable} shell ${shellIdentifier}`

		// Only generate color if terminal coloring is enabled (default: true)
		const backgroundColor = (options.colorTerminal ?? true)
			? options.colorHex
				? hexToRgb(options.colorHex)
				: generateColorFromBranchName(options.branchName).rgb
			: undefined

		await openTerminalWindow({
			workspacePath: options.worktreePath,
			command: shellCommand,
			...(backgroundColor && { backgroundColor }),
			// il shell handles env loading internally, so we don't need includeEnvSetup
			includeEnvSetup: false,
			includePortExport: options.capabilities.includes('web'),
			...(options.port !== undefined && { port: options.port }),
		})
		getLogger().info('Standalone terminal opened')
	}

	/**
	 * Build terminal options for Claude
	 */
	private async buildClaudeTerminalOptions(
		options: LaunchLoomOptions
	): Promise<TerminalWindowOptions> {
		const hasEnvFile = this.hasAnyEnvFiles(options.worktreePath)
		const claudeTitle = `Claude - ${this.formatIdentifier(options.workflowType, options.identifier)}`

		const executable = options.executablePath ?? 'iloom'
		let claudeCommand = `${executable} spin`
		if (options.oneShot !== undefined && options.oneShot !== 'default') {
			claudeCommand += ` --one-shot=${options.oneShot}`
		}
		if (options.setArguments && options.setArguments.length > 0) {
			for (const setArg of options.setArguments) {
				claudeCommand += ` --set ${setArg}`
			}
		}
		if (options.complexity) {
			claudeCommand += ` --complexity=${options.complexity}`
		}

		// Only generate color if terminal coloring is enabled (default: true)
		const backgroundColor = (options.colorTerminal ?? true)
			? options.colorHex
				? hexToRgb(options.colorHex)
				: generateColorFromBranchName(options.branchName).rgb
			: undefined

		return {
			workspacePath: options.worktreePath,
			command: claudeCommand,
			...(backgroundColor && { backgroundColor }),
			title: claudeTitle,
			includeEnvSetup: (options.sourceEnvOnStart ?? false) && hasEnvFile,
			...(options.port !== undefined && { port: options.port, includePortExport: true }),
		}
	}

	/**
	 * Build terminal options for dev server
	 * Uses `il dev-server [identifier]` which handles env loading internally
	 */
	private buildDevServerTerminalOptions(
		options: LaunchLoomOptions
	): TerminalWindowOptions {
		// Build dev-server command with identifier
		const executable = options.executablePath ?? getExecutablePath()
		const devServerIdentifier = String(options.identifier)
		const devServerCommand = `${executable} dev-server ${devServerIdentifier}`

		const devServerTitle = `Dev Server - ${this.formatIdentifier(options.workflowType, options.identifier)}`

		// Only generate color if terminal coloring is enabled (default: true)
		const backgroundColor = (options.colorTerminal ?? true)
			? options.colorHex
				? hexToRgb(options.colorHex)
				: generateColorFromBranchName(options.branchName).rgb
			: undefined

		return {
			workspacePath: options.worktreePath,
			command: devServerCommand,
			...(backgroundColor && { backgroundColor }),
			title: devServerTitle,
			// il dev-server handles env loading internally
			includeEnvSetup: false,
			includePortExport: options.capabilities.includes('web'),
			...(options.port !== undefined && { port: options.port }),
		}
	}

	/**
	 * Build terminal options for standalone terminal
	 * Runs `il shell <identifier>` which handles env loading internally
	 */
	private buildStandaloneTerminalOptions(
		options: LaunchLoomOptions
	): TerminalWindowOptions {
		const terminalTitle = `Terminal - ${this.formatIdentifier(options.workflowType, options.identifier)}`

		// Build shell command with identifier
		// Use the same executable path pattern as buildClaudeTerminalOptions
		const executable = options.executablePath ?? getExecutablePath()
		const shellIdentifier = String(options.identifier)
		const shellCommand = `${executable} shell ${shellIdentifier}`

		// Only generate color if terminal coloring is enabled (default: true)
		const backgroundColor = (options.colorTerminal ?? true)
			? options.colorHex
				? hexToRgb(options.colorHex)
				: generateColorFromBranchName(options.branchName).rgb
			: undefined

		return {
			workspacePath: options.worktreePath,
			command: shellCommand,
			...(backgroundColor && { backgroundColor }),
			title: terminalTitle,
			// il shell handles env loading internally, so we don't need includeEnvSetup
			includeEnvSetup: false,
			includePortExport: options.capabilities.includes('web'),
			...(options.port !== undefined && { port: options.port }),
		}
	}

	/**
	 * Launch multiple terminals (2+) as tabs in single window
	 */
	private async launchMultipleTerminals(
		terminals: Array<{ type: string; options: TerminalWindowOptions }>,
		_options: LaunchLoomOptions
	): Promise<void> {
		const terminalOptions = terminals.map((t) => t.options)

		await openMultipleTerminalWindows(terminalOptions)

		const terminalTypes = terminals.map((t) => t.type).join(' + ')
		getLogger().info(`Multiple terminals opened: ${terminalTypes}`)
	}

	/**
	 * Check if any dotenv-flow files exist in the workspace
	 * Checks all files: .env, .env.local, .env.{NODE_ENV}, .env.{NODE_ENV}.local
	 */
	private hasAnyEnvFiles(workspacePath: string): boolean {
		const envFiles = getDotenvFlowFiles()
		return envFiles.some(file => existsSync(join(workspacePath, file)))
	}

	/**
	 * Format identifier for terminal tab titles
	 */
	private formatIdentifier(workflowType: 'issue' | 'pr' | 'regular', identifier: string | number): string {
		if (workflowType === 'issue') {
			return `Issue #${identifier}`
		} else if (workflowType === 'pr') {
			return `PR #${identifier}`
		} else {
			return `Branch: ${identifier}`
		}
	}
}
