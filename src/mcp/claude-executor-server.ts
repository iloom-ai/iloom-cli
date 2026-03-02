/**
 * Claude Executor MCP Server
 *
 * Provides an `execute_claude` tool that spawns headless `claude -p` subprocesses
 * with proper environment setup, stream-json output parsing, and timeout enforcement.
 *
 * This replaces the unreliable bash-based `claude -p` invocation mechanism used by
 * swarm workers and wave verifiers. The MCP tool handles all subprocess lifecycle
 * concerns internally, returning only the extracted result text to the caller.
 *
 * Environment variables: none required (all config passed via tool parameters)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execa } from 'execa'
import { fileURLToPath } from 'node:url'

const DEFAULT_TIMEOUT_MS = 600_000 // 10 minutes
const DEFAULT_MAX_TURNS = 200

/**
 * Parse stream-json output from `claude -p --output-format stream-json`.
 *
 * Splits output by newlines, finds the last JSON line with `"type":"result"`,
 * and extracts the `result` field. This is the same logic as
 * `parseJsonStreamOutput` in `src/utils/claude.ts`.
 *
 * @param output - Raw stdout from `claude -p --output-format stream-json`
 * @returns The extracted result text, or empty string if no result line found
 */
export function parseStreamJsonResult(output: string): string {
	const lines = output.split('\n').filter((line) => line.trim())

	let lastResult = ''
	for (const line of lines) {
		try {
			const jsonObj = JSON.parse(line) as Record<string, unknown>
			if (
				jsonObj &&
				typeof jsonObj === 'object' &&
				jsonObj.type === 'result' &&
				'result' in jsonObj
			) {
				lastResult = String(jsonObj.result)
			}
		} catch {
			// Skip non-JSON lines (progress messages, etc.)
			continue
		}
	}

	return lastResult
}

export interface ExecuteClaudePParams {
	prompt: string
	systemPromptFile?: string | undefined
	mcpConfigPath?: string | undefined
	model?: string | undefined
	maxTurns?: number | undefined
	timeoutMs?: number | undefined
	workingDirectory?: string | undefined
	allowedTools?: string | undefined
}

export interface ExecuteClaudePResult {
	success: boolean
	result: string
	exitCode: number
	error: string | null
}

/**
 * Execute a headless `claude -p` process with proper environment setup and output parsing.
 *
 * Key behaviors:
 * - Strips CLAUDECODE from env to prevent "cannot be launched inside another Claude Code session" errors
 * - Sets ENABLE_TOOL_SEARCH, CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING, and other env vars
 * - Uses stream-json output format and parses the result
 * - Enforces timeout via execa's timeout option
 *
 * @param params - Parameters for the claude -p invocation
 * @returns Structured result with success flag, extracted text, exit code, and error
 */
export async function executeClaudeP(params: ExecuteClaudePParams): Promise<ExecuteClaudePResult> {
	const {
		prompt,
		systemPromptFile,
		mcpConfigPath,
		model,
		maxTurns = DEFAULT_MAX_TURNS,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		workingDirectory,
		allowedTools,
	} = params

	// Build args for claude -p
	const args: string[] = [
		'-p',
		'--output-format',
		'stream-json',
		'--verbose',
		'--permission-mode',
		'bypassPermissions',
		'--max-turns',
		String(maxTurns),
	]

	if (systemPromptFile) {
		args.push('--system-prompt-file', systemPromptFile)
	}

	if (mcpConfigPath) {
		args.push('--mcp-config', mcpConfigPath)
	}

	if (model) {
		args.push('--model', model)
	}

	if (allowedTools) {
		// allowedTools is a comma-separated string; split into individual tool names
		const tools = allowedTools.split(',').map((t) => t.trim()).filter(Boolean)
		if (tools.length > 0) {
			args.push('--allowed-tools', ...tools)
		}
	}

	// Build environment: start with process.env, strip CLAUDECODE, set required vars
	const env: Record<string, string | undefined> = { ...process.env }
	delete env.CLAUDECODE
	env.ENABLE_TOOL_SEARCH = 'auto:30'
	env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
	env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
	env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
	env.CLAUDE_CODE_EFFORT_LEVEL = 'medium'

	try {
		const result = await execa('claude', args, {
			input: prompt,
			timeout: timeoutMs,
			...(workingDirectory ? { cwd: workingDirectory } : {}),
			env,
		})

		const parsedResult = parseStreamJsonResult(result.stdout)

		return {
			success: true,
			result: parsedResult,
			exitCode: 0,
			error: null,
		}
	} catch (error: unknown) {
		const execaError = error as {
			exitCode?: number
			timedOut?: boolean
			message?: string
			stdout?: string
			stderr?: string
		}

		const timedOut = execaError.timedOut === true
		const exitCode = execaError.exitCode ?? 1
		const stderr = execaError.stderr ?? ''
		const stdout = execaError.stdout ?? ''

		// Even on error, try to extract any result from partial output
		const partialResult = stdout ? parseStreamJsonResult(stdout) : ''

		let errorMessage: string
		if (timedOut) {
			errorMessage = `Process timed out after ${timeoutMs}ms`
		} else {
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string stderr should fall through to message
			errorMessage = stderr || execaError.message || `Process exited with code ${exitCode}`
		}

		return {
			success: false,
			result: partialResult,
			exitCode,
			error: errorMessage,
		}
	}
}

// --- MCP Server setup ---

const server = new McpServer({
	name: 'iloom-claude-executor',
	version: '0.1.0',
})

server.registerTool(
	'execute_claude',
	{
		title: 'Execute Claude',
		description:
			'Execute a headless claude -p process with proper environment setup, output parsing, ' +
			'and timeout enforcement. Returns the extracted result text from the process. ' +
			'Use this to invoke phase agents, fix agents, or any sub-agent that needs to run as a separate process.',
		inputSchema: {
			prompt: z.string().describe('The prompt to send to claude -p via stdin'),
			systemPromptFile: z
				.string()
				.optional()
				.describe('Path to a system prompt file (--system-prompt-file)'),
			mcpConfigPath: z
				.string()
				.optional()
				.describe('Path to an MCP config file (--mcp-config). Pass the path from .claude/iloom-swarm-mcp-config-path'),
			model: z
				.string()
				.optional()
				.describe('Model to use (--model). E.g., "sonnet", "opus"'),
			maxTurns: z
				.number()
				.optional()
				.describe(`Max conversation turns (--max-turns). Default: ${DEFAULT_MAX_TURNS}`),
			timeoutMs: z
				.number()
				.optional()
				.describe(`Timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS} (10 minutes)`),
			workingDirectory: z
				.string()
				.optional()
				.describe('Working directory for the process (cwd). Typically the child worktree path'),
			allowedTools: z
				.string()
				.optional()
				.describe('Comma-separated list of allowed tools (--allowed-tools)'),
		},
	},
	async (params) => {
		const result = await executeClaudeP(params)

		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(result),
				},
			],
			isError: !result.success,
		}
	}
)

// Main server startup
async function main(): Promise<void> {
	console.error('=== Iloom Claude Executor MCP Server Starting ===')
	console.error(`PID: ${process.pid}`)
	console.error(`Node version: ${process.version}`)
	console.error(`CWD: ${process.cwd()}`)
	console.error(`Script: ${fileURLToPath(import.meta.url)}`)

	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error('=== Iloom Claude Executor MCP Server READY (stdio transport) ===')
}

// Only run main when executed directly (not when imported in tests)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
	main().catch((error) => {
		console.error('Fatal error starting MCP server:', error)
		process.exit(1)
	})
}
