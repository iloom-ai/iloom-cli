/**
 * Harness MCP Server
 *
 * Provides Claude with a `signal` tool to send structured messages to the iloom
 * harness process via Unix domain socket. This is the Claude-side counterpart to
 * the HarnessServer (#762).
 *
 * Environment variables:
 * - ILOOM_HARNESS_SOCKET: Path to the harness Unix domain socket (required)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { fileURLToPath } from 'node:url'
import net from 'net'

const SIGNAL_TIMEOUT_MS = 30_000

/**
 * Validate required environment variables
 * Exits with error if missing
 */
function validateEnvironment(): string {
	const socketPath = process.env.ILOOM_HARNESS_SOCKET

	if (!socketPath) {
		console.error('Missing required environment variable: ILOOM_HARNESS_SOCKET')
		process.exit(1)
	}

	return socketPath
}

let validatedSocketPath: string | null = null

/**
 * Get the validated socket path
 * Throws if called before validateEnvironment()
 */
function getSocketPath(): string {
	if (!validatedSocketPath) {
		throw new Error('ILOOM_HARNESS_SOCKET not validated - validateEnvironment() must be called first')
	}
	return validatedSocketPath
}

/**
 * Send a signal message to the harness via Unix domain socket and wait for response.
 * Returns the parsed response object, or throws on error/timeout.
 */
export function sendSignalToHarness(
	socketPath: string,
	message: { type: string; data?: Record<string, unknown> }
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath)

		let responseData = ''
		let settled = false

		const timeoutHandle = globalThis.setTimeout(() => {
			if (!settled) {
				settled = true
				socket.destroy()
				reject(new Error('Harness did not respond within 30s.'))
			}
		}, SIGNAL_TIMEOUT_MS)

		socket.on('connect', () => {
			const payload = JSON.stringify(message) + '\n'
			socket.write(payload)
		})

		socket.on('data', (chunk: Buffer) => {
			responseData += chunk.toString()

			const newlineIndex = responseData.indexOf('\n')
			if (newlineIndex !== -1) {
				const line = responseData.slice(0, newlineIndex).trim()
				if (!settled) {
					settled = true
					globalThis.clearTimeout(timeoutHandle)
					socket.destroy()
					try {
						const parsed = JSON.parse(line) as Record<string, unknown>
						resolve(parsed)
					} catch {
						reject(new Error(`Harness returned invalid JSON: ${line}`))
					}
				}
			}
		})

		socket.on('error', (err: NodeJS.ErrnoException) => {
			if (!settled) {
				settled = true
				globalThis.clearTimeout(timeoutHandle)
				// EPIPE and ECONNRESET mean the connection was closed before we could write/read
				if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
					reject(new Error('Harness closed connection before responding.'))
				} else {
					reject(err)
				}
			}
		})

		socket.on('close', () => {
			if (!settled) {
				settled = true
				globalThis.clearTimeout(timeoutHandle)
				reject(new Error('Harness closed connection before responding.'))
			}
		})
	})
}

// Initialize MCP server
const server = new McpServer({
	name: 'iloom-harness',
	version: '0.1.0',
})

// Register signal tool
server.registerTool(
	'signal',
	{
		title: 'Signal',
		description:
			'Send a structured signal to the iloom harness process and return the response. ' +
			'Use this to notify the harness of workflow events (e.g., done, status update).',
		inputSchema: {
			type: z.string().describe('Signal type (e.g., "done", "status")'),
			data: z.record(z.unknown()).optional().describe('Optional payload data for the signal'),
		},
	},
	async ({ type, data }) => {
		const socketPath = getSocketPath()
		const message: { type: string; data?: Record<string, unknown> } = { type }
		if (data !== undefined) {
			message.data = data as Record<string, unknown>
		}

		let response: Record<string, unknown>
		try {
			response = await sendSignalToHarness(socketPath, message)
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err)
			const isTimeout = errorMessage.includes('within 30s')
			const text = isTimeout
				? 'Error: Harness did not respond within 30s.'
				: `Error: ${errorMessage}`
			return {
				content: [{ type: 'text' as const, text }],
				isError: true,
			}
		}

		return {
			content: [{ type: 'text' as const, text: JSON.stringify(response) }],
		}
	}
)

// Main server startup
async function main(): Promise<void> {
	console.error('=== Iloom Harness MCP Server Starting ===')
	console.error(`PID: ${process.pid}`)
	console.error(`Node version: ${process.version}`)
	console.error(`CWD: ${process.cwd()}`)
	console.error(`Script: ${fileURLToPath(import.meta.url)}`)

	console.error('Environment variables:')
	console.error(`  ILOOM_HARNESS_SOCKET=${process.env.ILOOM_HARNESS_SOCKET ?? '<not set>'}`)

	validatedSocketPath = validateEnvironment()
	console.error(`Harness socket path: ${validatedSocketPath}`)

	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error('=== Iloom Harness MCP Server READY (stdio transport) ===')
}

// Only run main when executed directly (not when imported in tests)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
	main().catch((error) => {
		console.error('Fatal error starting MCP server:', error)
		process.exit(1)
	})
}
