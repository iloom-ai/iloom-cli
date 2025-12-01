import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger.js'

export interface ClaudeCliOptions {
	model?: string
	permissionMode?: 'plan' | 'acceptEdits' | 'bypassPermissions' | 'default'
	addDir?: string
	headless?: boolean
	branchName?: string // Optional branch name for terminal coloring
	port?: number // Optional port for terminal window export
	timeout?: number // Timeout in milliseconds
	appendSystemPrompt?: string // System instructions to append to system prompt
	mcpConfig?: Record<string, unknown>[] // Array of MCP server configurations
	allowedTools?: string[] // Tools to allow via --allowed-tools flag
	disallowedTools?: string[] // Tools to disallow via --disallowed-tools flag
	agents?: Record<string, unknown> // Agent configurations for --agents flag
	oneShot?: import('../types/index.js').OneShotMode // One-shot automation mode
	setArguments?: string[] // Raw --set arguments to forward (e.g., ['workflows.issue.startIde=false'])
	executablePath?: string // Executable path to use for spin command (e.g., 'il', 'il-125', or '/path/to/dist/cli.js')
}

/**
 * Detect if Claude CLI is available on the system
 */
export async function detectClaudeCli(): Promise<boolean> {
	try {
		// Use 'command -v' for cross-platform compatibility (works on macOS/Linux)
		await execa('command', ['-v', 'claude'], {
			shell: true,
			timeout: 5000,
		})
		return true
	} catch (error) {
		// Claude CLI not found
		logger.debug('Claude CLI not available', { error })
		return false
	}
}

/**
 * Get Claude CLI version
 */
export async function getClaudeVersion(): Promise<string | null> {
	try {
		const result = await execa('claude', ['--version'], {
			timeout: 5000,
		})
		return result.stdout.trim()
	} catch (error) {
		logger.warn('Failed to get Claude version', { error })
		return null
	}
}

/**
 * Parse JSON stream output and extract result from last JSON object with type:"result"
 */
function parseJsonStreamOutput(output: string): string {
	try {
		// Split by newlines and filter out empty lines
		const lines = output.split('\n').filter(line => line.trim())

		// Find the last valid JSON object with type:"result"
		let lastResult = ''
		for (const line of lines) {
			try {
				const jsonObj = JSON.parse(line)
				if (jsonObj && typeof jsonObj === 'object' && jsonObj.type === 'result' && 'result' in jsonObj) {
					lastResult = jsonObj.result
				}
			} catch {
				// Skip invalid JSON lines
				continue
			}
		}

		return lastResult || output // Fallback to original output if no valid result found
	} catch {
		// If parsing fails completely, return original output
		return output
	}
}

/**
 * Launch Claude CLI with specified options
 * In headless mode, returns stdout. In interactive mode, returns void.
 */
export async function launchClaude(
	prompt: string,
	options: ClaudeCliOptions = {}
): Promise<string | void> {
	const { model, permissionMode, addDir, headless = false, appendSystemPrompt, mcpConfig, allowedTools, disallowedTools, agents } = options

	// Build command arguments
	const args: string[] = []

	if (headless) {
		args.push('-p')

		// Add JSON streaming output for progress tracking
		args.push('--output-format', 'stream-json')
		args.push('--verbose')
	}

	if (model) {
		args.push('--model', model)
	}

	if (permissionMode && permissionMode !== 'default') {
		args.push('--permission-mode', permissionMode)
	}

	if (addDir) {
		args.push('--add-dir', addDir)
	}

	args.push('--add-dir', '/tmp') //TODO: Won't work on Windows

	// Add --append-system-prompt flag if provided
	if (appendSystemPrompt) {
		args.push('--append-system-prompt', appendSystemPrompt)
	}

	// Add --mcp-config flags for each MCP server configuration
	if (mcpConfig && mcpConfig.length > 0) {
		for (const config of mcpConfig) {
			args.push('--mcp-config', JSON.stringify(config))
		}
	}

	// Add --allowed-tools flags if provided
	if (allowedTools && allowedTools.length > 0) {
		args.push('--allowed-tools', ...allowedTools)
	}

	// Add --disallowed-tools flags if provided
	if (disallowedTools && disallowedTools.length > 0) {
		args.push('--disallowed-tools', ...disallowedTools)
	}

	// Add --agents flag if provided
	if (agents) {
		args.push('--agents', JSON.stringify(agents))
	}

	try {
		if (headless) {
			// Headless mode: capture and return output
			const isDebugMode = logger.isDebugEnabled()

			// Set up execa options based on debug mode
			const execaOptions = {
				input: prompt,
				timeout: 0, // Disable timeout for long responses
				...(addDir && { cwd: addDir }), // Run Claude in the worktree directory
				verbose: isDebugMode,
				...(isDebugMode && { stdio: ['pipe', 'pipe', 'pipe'] as const }), // Enable streaming in debug mode
			}

			const subprocess = execa('claude', args, execaOptions)

			// Check if JSON streaming format is enabled (always true in headless mode)
			const isJsonStreamFormat = args.includes('--output-format') && args.includes('stream-json')

			// Handle real-time streaming (enabled for progress tracking)
			let outputBuffer = ''
			let isStreaming = false
			let isFirstProgress = true
			if (subprocess.stdout && typeof subprocess.stdout.on === 'function') {
				isStreaming = true
				subprocess.stdout.on('data', (chunk: Buffer) => {
					const text = chunk.toString()
					outputBuffer += text

					if (isDebugMode) {
						process.stdout.write(text) // Full JSON streaming in debug mode
					} else {
						// Progress dots in non-debug mode with robot emoji prefix
						if (isFirstProgress) {
							process.stdout.write('🤖 .')
							isFirstProgress = false
						} else {
							process.stdout.write('.')
						}
					}
				})
			}

			const result = await subprocess

			// Return streamed output if we were streaming, otherwise use result.stdout
			if (isStreaming) {
				const rawOutput = outputBuffer.trim()

				// Clean up progress dots with newline in non-debug mode
				if (!isDebugMode) {
					process.stdout.write('\n')
				}

				return isJsonStreamFormat ? parseJsonStreamOutput(rawOutput) : rawOutput
			} else {
				// Fallback for mocked tests or when streaming not available
				if (isDebugMode) {
					// In debug mode, write to stdout even if not streaming (old behavior for tests)
					process.stdout.write(result.stdout)
					if (result.stdout && !result.stdout.endsWith('\n')) {
						process.stdout.write('\n')
					}
				} else {
					// In non-debug mode, show a single progress dot even without streaming (for tests)
					process.stdout.write('🤖 .')
					process.stdout.write('\n')
				}
				const rawOutput = result.stdout.trim()
				return isJsonStreamFormat ? parseJsonStreamOutput(rawOutput) : rawOutput
			}
		} else {
			// Simple interactive mode: run Claude in current terminal with stdio inherit
			// Used for conflict resolution, error fixing, etc.
			// This is the simple approach: claude -- "prompt"

			// Execute in current terminal (blocking, inherits stdio)
			await execa('claude', [...args, '--', prompt], {
				...(addDir && { cwd: addDir }),
				stdio: 'inherit', // Let user interact directly in current terminal
				timeout: 0, // Disable timeout
				verbose: logger.isDebugEnabled(),
			})

			return
		}
	} catch (error) {
		// Check for specific Claude CLI errors
		const execaError = error as {
			stderr?: string
			message?: string
			exitCode?: number
		}

		// Re-throw with more context
		const errorMessage = execaError.stderr ?? execaError.message ?? 'Unknown Claude CLI error'
		throw new Error(`Claude CLI error: ${errorMessage}`)
	}
}

/**
 * Launch Claude in a new terminal window with rich context
 * This is specifically for "end of il start" workflow
 * Ports the terminal window opening, coloring, and .env sourcing behavior
 */
export async function launchClaudeInNewTerminalWindow(
	_prompt: string,
	options: ClaudeCliOptions & {
		workspacePath: string // Required for terminal window launch
	}
): Promise<void> {
	const { workspacePath, branchName, oneShot = 'default', port, setArguments, executablePath } = options

	// Verify required parameter
	if (!workspacePath) {
		throw new Error('workspacePath is required for terminal window launch')
	}

	// Import terminal launcher for new terminal window creation
	const { openTerminalWindow } = await import('./terminal.js')

	// Build launch command with optional --one-shot flag
	// Use provided executable path or fallback to 'il'
	const executable = executablePath ?? 'iloom'
	let launchCommand = `${executable} spin`
	if (oneShot !== 'default') {
		launchCommand += ` --one-shot=${oneShot}`
	}

	// Append --set arguments if provided
	if (setArguments && setArguments.length > 0) {
		for (const setArg of setArguments) {
			launchCommand += ` --set ${setArg}`
		}
	}

	// Apply terminal background color if branch name available
	let backgroundColor: { r: number; g: number; b: number } | undefined
	if (branchName) {
		try {
			const { generateColorFromBranchName } = await import('./color.js')
			const colorData = generateColorFromBranchName(branchName)
			backgroundColor = colorData.rgb
		} catch (error) {
			logger.warn(
				`Failed to generate terminal color: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
		}
	}

	// Check if .env file exists in workspace
	const hasEnvFile = existsSync(join(workspacePath, '.env'))

	// Open new terminal window with Claude
	await openTerminalWindow({
		workspacePath,
		command: launchCommand,
		...(backgroundColor && { backgroundColor }),
		includeEnvSetup: hasEnvFile, // source .env only if it exists
		...(port !== undefined && { port, includePortExport: true }),
	})
}

/**
 * Generate a branch name using Claude with fallback
 * This matches the implementation that was working in ClaudeBranchNameStrategy
 */
export async function generateBranchName(
	issueTitle: string,
	issueNumber: string | number,
	model: string = 'haiku'
): Promise<string> {
	try {
		// Check if Claude CLI is available
		const isAvailable = await detectClaudeCli()
		if (!isAvailable) {
			logger.warn('Claude CLI not available, using fallback branch name')
			return `feat/issue-${issueNumber}`
		}

		logger.debug('Generating branch name with Claude', { issueNumber, issueTitle })

		// Use the proven prompt format from ClaudeBranchNameStrategy
		const prompt = `<Task>
Generate a git branch name for the following issue:
<Issue>
<IssueNumber>${issueNumber}</IssueNumber>
<IssueTitle>${issueTitle}</IssueTitle>
</Issue>

<Requirements>
<IssueNumber>Must use this exact issue number: ${issueNumber}</IssueNumber>
<Format>Format must be: {prefix}/issue-${issueNumber}-{description}</Format>
<Prefix>Prefix must be one of: feat, fix, docs, refactor, test, chore</Prefix>
<MaxLength>Maximum 50 characters total</MaxLength>
<Characters>Only lowercase letters, numbers, and hyphens allowed</Characters>
<Output>Reply with ONLY the branch name, nothing else</Output>
</Requirements>
</Task>`

		logger.debug('Sending prompt to Claude', { prompt })

		const result = (await launchClaude(prompt, {
			model,
			headless: true,
		})) as string

		const branchName = result.trim()
		logger.debug('Claude returned branch name', { branchName, issueNumber })

		// Validate generated name using same validation as ClaudeBranchNameStrategy
		if (!branchName || !isValidBranchName(branchName, issueNumber)) {
			logger.warn('Invalid branch name from Claude, using fallback', { branchName })
			return `feat/issue-${issueNumber}`
		}

		return branchName
	} catch (error) {
		logger.warn('Failed to generate branch name with Claude', { error })
		return `feat/issue-${issueNumber}`
	}
}

/**
 * Validate branch name format
 * Check format: {prefix}/issue-{number}-{description}
 */
function isValidBranchName(name: string, issueNumber: string | number): boolean {
	const pattern = new RegExp(`^(feat|fix|docs|refactor|test|chore)/issue-${issueNumber}-[a-z0-9-]+$`)
	return pattern.test(name) && name.length <= 50
}
