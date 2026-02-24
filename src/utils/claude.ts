import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { logger } from './logger.js'
import { getLogger } from './logger-context.js'
import { openTerminalWindow } from './terminal.js'

/**
 * Generate a deterministic UUID v5 from a worktree path
 * Uses SHA1 hash with URL namespace to create a consistent session ID
 * that can be used to resume Claude Code sessions
 */
export function generateDeterministicSessionId(worktreePath: string): string {
	// UUID v5 namespace for URLs (RFC 4122)
	const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'

	// Create SHA1 hash of namespace + path
	const hash = createHash('sha1')

	// Convert namespace UUID to bytes
	const namespaceBytes = Buffer.from(URL_NAMESPACE.replace(/-/g, ''), 'hex')
	hash.update(namespaceBytes)
	hash.update(worktreePath)

	const digest = hash.digest()

	// Format as UUID v5:
	// - Set version (bits 12-15 of time_hi_and_version) to 5
	// - Set variant (bits 6-7 of clock_seq_hi_and_reserved) to binary 10
	const bytes = Array.from(digest.subarray(0, 16))

	// Set version to 5 (byte 6, high nibble)
	const byte6 = bytes[6] ?? 0
	bytes[6] = (byte6 & 0x0f) | 0x50

	// Set variant to RFC 4122 (byte 8, high 2 bits = 10)
	const byte8 = bytes[8] ?? 0
	bytes[8] = (byte8 & 0x3f) | 0x80

	// Format as UUID string
	const hex = Buffer.from(bytes).toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Generate a random UUID v4 for session ID
 * Uses crypto.randomUUID() for cryptographically secure random UUID generation
 * Used to create unique session IDs for each loom, enabling fresh Claude sessions
 */
export function generateRandomSessionId(): string {
	return randomUUID()
}

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
	sessionId?: string // Session ID for Claude Code resume support (must be valid UUID)
	noSessionPersistence?: boolean // Prevent session data from being saved to disk (for utility operations)
	outputFormat?: 'json' | 'stream-json' | 'text' // Output format for Claude CLI (headless mode)
	verbose?: boolean // Enable verbose output (headless mode) - defaults to true when headless
	jsonMode?: 'json' | 'stream' // JSON output mode: 'json' for final object, 'stream' for real-time JSONL
	passthroughStdout?: boolean // In headless mode, pipe stdout to process.stdout instead of capturing
	env?: Record<string, string> // Additional environment variables to pass to the Claude process
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
	const { model, permissionMode, addDir, headless = false, appendSystemPrompt, mcpConfig, allowedTools, disallowedTools, agents, sessionId, noSessionPersistence, outputFormat, verbose, jsonMode, passthroughStdout, env: extraEnv } = options
	const log = getLogger()

	// Build command arguments
	const args: string[] = []

	if (headless) {
		args.push('-p')

		// Use user-provided outputFormat or default to stream-json for progress tracking
		const effectiveOutputFormat = outputFormat ?? 'stream-json'
		args.push('--output-format', effectiveOutputFormat)

		// Use user-provided verbose setting or default to true
		if (verbose !== false) {
			args.push('--verbose')
		}
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

	// Add --session-id flag if provided (enables Claude Code session resume)
	if (sessionId) {
		args.push('--session-id', sessionId)
	}

	// Add --no-session-persistence flag if requested (for utility operations that don't need session persistence)
	// Note: --no-session-persistence can only be used with --print mode (-p), which is only added in headless mode
	if (noSessionPersistence && headless) {
		args.push('--no-session-persistence')
	}

	// Set CLAUDECODE=0 to prevent Claude from detecting it's running inside Claude Code
	const claudeEnv = { ...process.env, CLAUDECODE: '0' }

	try {
		if (headless && passthroughStdout) {
			// Headless + passthrough: Claude's stdout goes directly to process.stdout
			// Used for --json-stream where JSONL must reach the caller's stdout
			const subprocess = execa('claude', args, {
				input: prompt,
				timeout: 0,
				...(addDir && { cwd: addDir }),
				env: { ...claudeEnv, ...extraEnv }, // CLAUDECODE=0 + any extra env vars
				stdio: ['pipe', 'inherit', 'pipe'], // stdin: pipe (for prompt), stdout: inherit (passthrough), stderr: pipe (capture errors)
			})

			await subprocess
			return // No output to return - it went directly to stdout
		}

		if (headless) {
			// Headless mode: capture and return output
			const isDebugMode = logger.isDebugEnabled()

			// Set up execa options based on debug mode
			const execaOptions = {
				input: prompt,
				timeout: 0, // Disable timeout for long responses
				...(addDir && { cwd: addDir }), // Run Claude in the worktree directory
				verbose: isDebugMode,
				env: { ...claudeEnv, ...extraEnv }, // CLAUDECODE=0 + any extra env vars
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

					if (jsonMode === 'stream') {
						// --json-stream: Output raw JSONL to stdout immediately
						process.stdout.write(text)
					} else if (jsonMode === 'json') {
						// --json: Suppress all progress output (will return final JSON)
						// Do nothing - just accumulate in buffer
					} else if (isDebugMode) {
						log.stdout.write(text) // Full JSON streaming in debug mode
					} else {
						// Progress dots in non-debug mode with robot emoji prefix
						if (isFirstProgress) {
							log.stdout.write('🤖 .')
							isFirstProgress = false
						} else {
							log.stdout.write('.')
						}
					}
				})
			}

			const result = await subprocess

			// Return streamed output if we were streaming, otherwise use result.stdout
			if (isStreaming) {
				const rawOutput = outputBuffer.trim()

				// Clean up progress dots with newline in non-debug mode (skip for json modes)
				if (!isDebugMode && !jsonMode) {
					log.stdout.write('\n')
				}

				return isJsonStreamFormat ? parseJsonStreamOutput(rawOutput) : rawOutput
			} else {
				// Fallback for mocked tests or when streaming not available
				if (isDebugMode) {
					// In debug mode, write to stdout even if not streaming (old behavior for tests)
					log.stdout.write(result.stdout)
					if (result.stdout && !result.stdout.endsWith('\n')) {
						log.stdout.write('\n')
					}
				} else {
					// In non-debug mode, show a single progress dot even without streaming (for tests)
					log.stdout.write('🤖 .')
					log.stdout.write('\n')
				}
				const rawOutput = result.stdout.trim()
				return isJsonStreamFormat ? parseJsonStreamOutput(rawOutput) : rawOutput
			}
		} else {
			// Simple interactive mode: run Claude in current terminal with stdio inherit
			// Used for conflict resolution, error fixing, etc.
			// This is the simple approach: claude -- "prompt"

			// First attempt: capture stderr to detect session ID conflicts
			// stdin/stdout inherit for interactivity, stderr captured for error detection
			try {
				await execa('claude', [...args, '--', prompt], {
					...(addDir && { cwd: addDir }),
					stdio: ['inherit', 'inherit', 'pipe'], // Capture stderr to detect session conflicts
					timeout: 0, // Disable timeout
					verbose: logger.isDebugEnabled(),
					env: { ...claudeEnv, ...extraEnv }, // CLAUDECODE=0 + any extra env vars
				})
				return
			} catch (interactiveError) {
				const interactiveExecaError = interactiveError as { stderr?: string; message?: string }
				const interactiveErrorMessage = interactiveExecaError.stderr ?? interactiveExecaError.message ?? ''

				// Check for session ID conflict
				const sessionMatch = interactiveErrorMessage.match(/Session ID ([0-9a-f-]+) is already in use/i)
				const conflictSessionId = sessionMatch?.[1]
				if (sessionMatch && sessionId && conflictSessionId) {
					log.debug(`Session ID ${conflictSessionId} already in use, retrying with --resume`)

					// Rebuild args with --resume instead of --session-id
					const resumeArgs = args.filter((arg, idx) => {
						if (arg === '--session-id') return false
						if (idx > 0 && args[idx - 1] === '--session-id') return false
						return true
					})
					resumeArgs.push('--resume', conflictSessionId)

					// Retry with full stdio inherit for proper interactive experience
					// Note: When using --resume, we omit the prompt since the session already has context
					await execa('claude', resumeArgs, {
						...(addDir && { cwd: addDir }),
						stdio: 'inherit',
						timeout: 0,
						verbose: logger.isDebugEnabled(),
						env: claudeEnv,
					})
					return
				}

				// Not a session conflict, re-throw
				throw interactiveError
			}
		}
	} catch (error) {
		// Check for specific Claude CLI errors
		const execaError = error as {
			stderr?: string
			message?: string
			exitCode?: number
		}

		const errorMessage = execaError.stderr ?? execaError.message ?? 'Unknown Claude CLI error'

		// Check for "Session ID ... is already in use" error and retry with --resume
		const sessionInUseMatch = errorMessage.match(/Session ID ([0-9a-f-]+) is already in use/i)
		const extractedSessionId = sessionInUseMatch?.[1]
		if (sessionInUseMatch && sessionId && extractedSessionId) {
			log.debug(`Session ID ${extractedSessionId} already in use, retrying with --resume`)

			// Rebuild args with --resume instead of --session-id
			const resumeArgs = args.filter((arg, idx) => {
				// Filter out --session-id and its value
				if (arg === '--session-id') return false
				if (idx > 0 && args[idx - 1] === '--session-id') return false
				return true
			})
			resumeArgs.push('--resume', extractedSessionId)

			try {
				if (headless) {
					const isDebugMode = logger.isDebugEnabled()
					// Note: In headless mode, we still need to pass the prompt even with --resume
					// because there's no interactive input mechanism
					const execaOptions = {
						input: prompt,
						timeout: 0,
						...(addDir && { cwd: addDir }),
						verbose: isDebugMode,
						env: claudeEnv,
						...(isDebugMode && { stdio: ['pipe', 'pipe', 'pipe'] as const }),
					}

					const subprocess = execa('claude', resumeArgs, execaOptions)
					const isJsonStreamFormat = resumeArgs.includes('--output-format') && resumeArgs.includes('stream-json')

					let outputBuffer = ''
					let isStreaming = false
					let isFirstProgress = true
					if (subprocess.stdout && typeof subprocess.stdout.on === 'function') {
						isStreaming = true
						subprocess.stdout.on('data', (chunk: Buffer) => {
							const text = chunk.toString()
							outputBuffer += text
							if (jsonMode === 'stream') {
								process.stdout.write(text)
							} else if (jsonMode === 'json') {
								// Suppress progress output for json mode
							} else if (isDebugMode) {
								log.stdout.write(text)
							} else {
								if (isFirstProgress) {
									log.stdout.write('🤖 .')
									isFirstProgress = false
								} else {
									log.stdout.write('.')
								}
							}
						})
					}

					const result = await subprocess

					if (isStreaming) {
						const rawOutput = outputBuffer.trim()
						if (!isDebugMode && !jsonMode) {
							log.stdout.write('\n')
						}
						return isJsonStreamFormat ? parseJsonStreamOutput(rawOutput) : rawOutput
					} else {
						if (isDebugMode) {
							log.stdout.write(result.stdout)
							if (result.stdout && !result.stdout.endsWith('\n')) {
								log.stdout.write('\n')
							}
						} else {
							log.stdout.write('🤖 .')
							log.stdout.write('\n')
						}
						const rawOutput = result.stdout.trim()
						return isJsonStreamFormat ? parseJsonStreamOutput(rawOutput) : rawOutput
					}
				} else {
					// Note: When using --resume, we omit the prompt since the session already has context
					await execa('claude', resumeArgs, {
						...(addDir && { cwd: addDir }),
						stdio: 'inherit',
						timeout: 0,
						verbose: logger.isDebugEnabled(),
						env: claudeEnv,
					})
					return
				}
			} catch (retryError) {
				const retryExecaError = retryError as { stderr?: string; message?: string }
				const retryErrorMessage = retryExecaError.stderr ?? retryExecaError.message ?? 'Unknown Claude CLI error'
				throw new Error(`Claude CLI error: ${retryErrorMessage}`)
			}
		}

		// Re-throw with more context
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
<Format>Format must be: {prefix}/issue-${issueNumber}__{description}</Format>
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
			noSessionPersistence: true, // Utility operation - don't persist session
			env: { CLAUDE_CODE_SIMPLE: '1' }, // Minimal mode - no MCP, hooks, or CLAUDE.md loading
		})) as string

		// Normalize to lowercase for consistency (Linear IDs are uppercase but branches should be lowercase)
		const branchName = result.trim().toLowerCase()
		logger.debug('Claude returned branch name', { branchName, issueNumber })

		// Validate generated name using same validation as ClaudeBranchNameStrategy
		if (!branchName || !isValidBranchName(branchName, issueNumber)) {
			logger.warn('Invalid branch name from Claude, using fallback', { branchName })
			return `feat/issue-${issueNumber}`.toLowerCase()
		}

		return branchName
	} catch (error) {
		logger.warn('Failed to generate branch name with Claude', { error })
		return `feat/issue-${issueNumber}`.toLowerCase()
	}
}

/**
 * Validate branch name format
 * Check format: {prefix}/issue-{number}__{description}
 * Uses case-insensitive matching for issue number (Linear uses uppercase like MARK-1)
 */
function isValidBranchName(name: string, issueNumber: string | number): boolean {
	const pattern = new RegExp(`^(feat|fix|docs|refactor|test|chore)/issue-${issueNumber}__[a-z0-9-]+$`, 'i')
	return pattern.test(name) && name.length <= 50
}
