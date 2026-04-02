/* global AbortSignal */
import { execa, type ExecaChildProcess } from 'execa'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
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
	systemPrompt?: string // Full system prompt (replaces default, use with --bare)
	appendSystemPrompt?: string // System instructions to append to system prompt
	appendSystemPromptFile?: string // Path to file containing system instructions
	mcpConfig?: Record<string, unknown>[] // Array of MCP server configurations
	allowedTools?: string[] // Tools to allow via --allowed-tools flag
	disallowedTools?: string[] // Tools to disallow via --disallowed-tools flag
	agents?: Record<string, unknown> // Agent configurations for --agents flag
	pluginDir?: string // Path to plugin directory for --plugin-dir flag
	oneShot?: import('../types/index.js').OneShotMode // One-shot automation mode
	setArguments?: string[] // Raw --set arguments to forward (e.g., ['workflows.issue.startIde=false'])
	executablePath?: string // Executable path to use for spin command (e.g., 'il', 'il-125', or '/path/to/dist/cli.js')
	sessionId?: string // Session ID for Claude Code resume support (must be valid UUID)
	noSessionPersistence?: boolean // Prevent session data from being saved to disk (for utility operations)
	outputFormat?: 'json' | 'stream-json' | 'text' // Output format for Claude CLI (headless mode)
	verbose?: boolean // Enable verbose output (headless mode) - defaults to true when headless
	jsonMode?: 'json' | 'stream' // JSON output mode: 'json' for final object, 'stream' for real-time JSONL
	passthroughStdout?: boolean // In headless mode, pipe stdout to process.stdout instead of capturing
	effort?: string // Effort level to pass via --effort flag (e.g., 'low', 'high', 'max')
	env?: Record<string, string> // Additional environment variables to pass to the Claude process
	signal?: AbortSignal // Optional AbortSignal for graceful termination of the Claude process
	bare?: boolean // Minimal mode: skip hooks, LSP, plugins, CLAUDE.md auto-discovery. Requires ANTHROPIC_API_KEY (disables OAuth/keychain).
	settings?: string // JSON settings string for --settings flag (e.g., '{"apiKeyHelper": "echo TOKEN"}')
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
	const { model, permissionMode, addDir, headless = false, systemPrompt, appendSystemPrompt, appendSystemPromptFile, mcpConfig, allowedTools, disallowedTools, agents, pluginDir, sessionId, noSessionPersistence, outputFormat, verbose, jsonMode, passthroughStdout, effort, env: extraEnv, signal, bare, settings } = options
	const log = getLogger()

	// Resolve bare mode configuration
	let effectiveBare = bare ?? false
	let effectiveSettings = settings
	let bareModeAutoApplied = false
	let oauthToken: string | undefined

	// Auto-apply bare mode for headless utility operations when not explicitly set
	if (bare === undefined && headless && noSessionPersistence) {
		const config = await resolveBareModeConfig()
		effectiveBare = config.bare
		effectiveSettings ??= config.settings
		oauthToken = config.oauthToken
		bareModeAutoApplied = config.bare // track that WE decided to use bare
	}

	// When caller explicitly sets bare:true without settings, resolve OAuth settings too
	if (bare === true && !effectiveSettings) {
		const config = await resolveBareModeConfig()
		effectiveSettings ??= config.settings
		oauthToken = config.oauthToken
		// bareModeAutoApplied stays false - caller explicitly requested bare
	}

	const isDebugMode = logger.isDebugEnabled()

	// Set CLAUDECODE=0 to prevent Claude from detecting it's running inside Claude Code
	const claudeEnv = { ...process.env, CLAUDECODE: '0' }

	// Helper to build common args (avoids duplication between attempts)
	function buildBaseArgs(includeBare: boolean): string[] {
		const args: string[] = []

		if (includeBare && effectiveBare) {
			args.push('--bare')
		}

		if (includeBare && effectiveSettings) {
			args.push('--settings', effectiveSettings)
		}

		if (headless) {
			args.push('-p')
			const effectiveOutputFormat = outputFormat ?? 'stream-json'
			args.push('--output-format', effectiveOutputFormat)
			if (verbose !== false) {
				args.push('--verbose')
			}
		}

		if (model) {
			args.push('--model', model)
		}

		if (effort) {
			args.push('--effort', effort)
		}

		if (permissionMode && permissionMode !== 'default') {
			args.push('--permission-mode', permissionMode)
		}

		if (addDir) {
			args.push('--add-dir', addDir)
		}

		args.push('--add-dir', '/tmp') //TODO: Won't work on Windows

		if (systemPrompt) {
			args.push('--system-prompt', systemPrompt)
		}

		if (appendSystemPrompt) {
			args.push('--append-system-prompt', appendSystemPrompt)
		}

		if (appendSystemPromptFile) {
			args.push('--append-system-prompt-file', appendSystemPromptFile)
		}

		if (mcpConfig && mcpConfig.length > 0) {
			for (const config of mcpConfig) {
				args.push('--mcp-config', JSON.stringify(config))
			}
		}

		if (allowedTools && allowedTools.length > 0) {
			args.push('--allowed-tools', ...allowedTools)
		}

		if (disallowedTools && disallowedTools.length > 0) {
			args.push('--disallowed-tools', ...disallowedTools)
		}

		if (agents) {
			args.push('--agents', JSON.stringify(agents))
		}

		if (pluginDir) {
			args.push('--plugin-dir', pluginDir)
		}

		if (sessionId) {
			args.push('--session-id', sessionId)
		}

		if (isDebugMode) {
			args.push('--debug')
		}

		if (noSessionPersistence && headless) {
			args.push('--no-session-persistence')
		}

		return args
	}

	// Build environment with optional OAuth token
	function buildEnv(includeBareEnv: boolean): Record<string, string | undefined> {
		const env: Record<string, string | undefined> = { ...claudeEnv, ...extraEnv }
		if (includeBareEnv && oauthToken) {
			env.__ILOOM_OAUTH_TOKEN = oauthToken
		}
		return env
	}

	// Helper to attach AbortSignal to a subprocess for graceful termination
	function attachAbortSignal(subprocess: ExecaChildProcess): void {
		if (!signal) return
		const onAbort = (): void => {
			subprocess.kill('SIGTERM')
		}
		signal.addEventListener('abort', onAbort, { once: true })
		subprocess.on('exit', (): void => {
			signal.removeEventListener('abort', onAbort)
		})
	}

	// Helper to redact --settings content from error messages to avoid token leakage
	function redactSettings(msg: string): string {
		return msg.replace(/--settings\s+'[^']*'/g, "--settings '[REDACTED]'")
			.replace(/--settings\s+"[^"]*"/g, '--settings "[REDACTED]"')
			.replace(/--settings\s+\S+/g, '--settings [REDACTED]')
	}

	// Helper to run headless subprocess and handle output streaming
	async function runHeadlessSubprocess(args: string[], env: Record<string, string | undefined>): Promise<string | void> {
		const execaOptions = {
			input: prompt,
			timeout: 0,
			...(addDir && { cwd: addDir }),
			verbose: isDebugMode,
			env,
			...(isDebugMode && { stdio: ['pipe', 'pipe', 'pipe'] as const }),
		}

		const subprocess = execa('claude', args, execaOptions)
		attachAbortSignal(subprocess)

		const isJsonStreamFormat = args.includes('--output-format') && args.includes('stream-json')

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

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let result: any
		try {
			result = await subprocess
		} catch (subprocessError) {
			if (signal?.aborted) return
			throw subprocessError
		}

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
	}

	// Handle headless + passthrough mode (separate path, no retry)
	if (headless && passthroughStdout) {
		const args = buildBaseArgs(true)
		const subprocess = execa('claude', args, {
			input: prompt,
			timeout: 0,
			...(addDir && { cwd: addDir }),
			env: buildEnv(true),
			stdio: ['pipe', 'inherit', 'pipe'],
		})

		attachAbortSignal(subprocess)
		try {
			await subprocess
		} catch (err) {
			if (signal?.aborted) return
			throw err
		}
		return
	}

	// Handle headless mode with retry loop (max 2 attempts)
	if (headless) {
		const maxAttempts = bareModeAutoApplied ? 2 : 1
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const useBare = attempt === 1
			const args = buildBaseArgs(useBare)
			const env = buildEnv(useBare)

			try {
				return await runHeadlessSubprocess(args, env)
			} catch (error) {
				if (signal?.aborted) return

				const execaError = error as { stderr?: string; message?: string; exitCode?: number }
				// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string stderr should fall through to message
				const rawErrorMessage = execaError.stderr || execaError.message || 'Unknown Claude CLI error'
				const errorMessage = redactSettings(rawErrorMessage)

				// On first attempt with auto-applied bare mode, check for auth failure and retry
				if (attempt === 1 && bareModeAutoApplied) {
					const isAuthError = /not logged in|unauthorized|authentication|invalid api key|Could not resolve credentials/i.test(rawErrorMessage)
					if (isAuthError) {
						logger.warn('Bare mode failed (likely expired OAuth token), retrying without --bare')
						continue // Retry without bare on next iteration
					}
				}

				// Check for "Session ID ... is already in use" error and retry with --resume
				const sessionInUseMatch = errorMessage.match(/Session ID ([0-9a-f-]+) is already in use/i)
				const extractedSessionId = sessionInUseMatch?.[1]
				if (sessionInUseMatch && sessionId && extractedSessionId) {
					log.debug(`Session ID ${extractedSessionId} already in use, retrying with --resume`)

					// Build clean args with --resume instead of --session-id
					const resumeArgs = args.filter((arg, idx) => {
						if (arg === '--session-id') return false
						if (idx > 0 && args[idx - 1] === '--session-id') return false
						return true
					})
					resumeArgs.push('--resume', extractedSessionId)

					try {
						return await runHeadlessSubprocess(resumeArgs, env)
					} catch (retryError) {
						const retryExecaError = retryError as { stderr?: string; message?: string }
						// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string stderr should fall through to message
						const retryErrorMessage = retryExecaError.stderr || retryExecaError.message || 'Unknown Claude CLI error'
						throw new Error(`Claude CLI error: ${redactSettings(retryErrorMessage)}`)
					}
				}

				throw new Error(`Claude CLI error: ${errorMessage}`)
			}
		}
		return
	}

	// Interactive mode: run Claude in current terminal with stdio inherit
	// Used for conflict resolution, error fixing, etc.
	const args = buildBaseArgs(true)

	try {
		const interactiveSubprocess = execa('claude', [...args, '--', prompt], {
			...(addDir && { cwd: addDir }),
			stdio: ['inherit', 'inherit', 'pipe'],
			timeout: 0,
			verbose: logger.isDebugEnabled(),
			env: buildEnv(true),
		})
		attachAbortSignal(interactiveSubprocess)
		try {
			await interactiveSubprocess
		} catch (err) {
			if (signal?.aborted) return
			throw err
		}
		return
	} catch (interactiveError) {
		if (signal?.aborted) return
		const interactiveExecaError = interactiveError as { stderr?: string; message?: string }
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string stderr should fall through to message
		const interactiveErrorMessage = interactiveExecaError.stderr || interactiveExecaError.message || ''

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
			const resumeSubprocess = execa('claude', resumeArgs, {
				...(addDir && { cwd: addDir }),
				stdio: 'inherit',
				timeout: 0,
				verbose: logger.isDebugEnabled(),
				env: claudeEnv,
			})
			attachAbortSignal(resumeSubprocess)
			try {
				await resumeSubprocess
			} catch (err) {
				if (signal?.aborted) return
				throw err
			}
			return
		}

		// Not a session conflict - redact any settings content and re-throw
		const redactedMessage = redactSettings(interactiveErrorMessage)
		if (redactedMessage !== interactiveErrorMessage) {
			throw new Error(`Claude CLI error: ${redactedMessage}`)
		}
		throw interactiveError
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
 * Extract an OAuth access token from Claude Code's credential stores.
 *
 * Checks in order:
 * 1. CLAUDE_CODE_OAUTH_TOKEN env var (fastest, used in CI)
 * 2. macOS Keychain via `security find-generic-password` (darwin only)
 * 3. ~/.claude/.credentials.json (Linux and other platforms)
 *
 * Returns the token string, or null if unavailable/expired/error.
 */
export async function extractOAuthToken(): Promise<string | null> {
	try {
		// 1. Check CLAUDE_CODE_OAUTH_TOKEN env var (fastest path, used in CI/Actions)
		const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
		if (envToken) {
			logger.debug('Using OAuth token from CLAUDE_CODE_OAUTH_TOKEN env var')
			return envToken
		}

		let credentialsJson: string

		if (process.platform === 'darwin') {
			// 2. macOS: read from Keychain
			const username = process.env.USER ?? process.env.LOGNAME ?? 'unknown'
			const result = await execa('security', [
				'find-generic-password',
				'-s', 'Claude Code-credentials',
				'-a', username,
				'-w',
			], { timeout: 3000 })
			credentialsJson = result.stdout.trim()
		} else {
			// 3. Linux/other: read from credentials file
			const credentialsPath = join(homedir(), '.claude', '.credentials.json')
			credentialsJson = await readFile(credentialsPath, 'utf-8')
		}

		const credentials = JSON.parse(credentialsJson)
		const oauth = credentials?.claudeAiOauth
		if (!oauth?.accessToken) {
			logger.debug('No OAuth access token found in credentials')
			return null
		}

		// Check token expiry
		if (oauth.expiresAt && typeof oauth.expiresAt === 'number') {
			// Heuristic: if expiresAt < 10 billion, it's in seconds; multiply to get ms
			const expiresAtMs = oauth.expiresAt < 10_000_000_000
				? oauth.expiresAt * 1000
				: oauth.expiresAt
			// Add 60-second buffer to avoid using tokens about to expire
			if (expiresAtMs <= Date.now() + 60_000) {
				logger.debug('OAuth token is expired or expiring within 60s')
				return null
			}
		}

		logger.debug('Extracted OAuth token from credential store')
		return oauth.accessToken
	} catch (error) {
		logger.debug('Failed to extract OAuth token', { error })
		return null
	}
}

/**
 * Resolve bare mode configuration including OAuth-based apiKeyHelper.
 *
 * Priority:
 * 1. ANTHROPIC_API_KEY set -> { bare: true } (no settings needed)
 * 2. OAuth token available -> { bare: true, settings: '{"apiKeyHelper": "..."}' }
 * 3. Neither available -> { bare: false }
 */
export async function resolveBareModeConfig(): Promise<{ bare: boolean; settings?: string; oauthToken?: string }> {
	// Fast path: API key is set, bare mode works natively
	if (process.env.ANTHROPIC_API_KEY?.trim()) {
		logger.debug('Bare mode enabled via ANTHROPIC_API_KEY')
		return { bare: true }
	}

	// Try OAuth token extraction
	const token = await extractOAuthToken()
	if (token) {
		// Pass token via env var (__ILOOM_OAUTH_TOKEN) instead of embedding in args
		// to avoid exposing it in `ps aux` output
		const settings = JSON.stringify({ apiKeyHelper: 'echo $__ILOOM_OAUTH_TOKEN' })
		logger.debug('Bare mode enabled via OAuth token with apiKeyHelper')
		return { bare: true, settings, oauthToken: token }
	}

	logger.debug('No API key or OAuth token available, bare mode disabled')
	return { bare: false }
}

/**
 * Check if an API key is available for --bare mode (synchronous check).
 * Bare mode skips hooks, LSP, plugins, and CLAUDE.md auto-discovery for faster startup.
 * It requires ANTHROPIC_API_KEY since --bare disables OAuth/keychain auth.
 *
 * Note: For the full async check that includes OAuth token extraction,
 * use resolveBareModeConfig() instead.
 */
export function hasApiKeyForBareMode(): boolean {
	return !!process.env.ANTHROPIC_API_KEY?.trim()
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
			systemPrompt: 'You are a git branch name generator. Given an issue title and number, generate a branch name following the exact format and constraints provided. Output only the branch name, nothing else. No preamble, analysis, or meta-commentary.',
			effort: 'low', // Simple text generation, minimize turns
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
