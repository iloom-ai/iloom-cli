import { describe, it, expect, vi, afterEach } from 'vitest'
import net from 'net'
import { sendSignalToHarness } from './harness-server.js'

/**
 * Tests for the harness MCP server's socket communication logic.
 *
 * We test sendSignalToHarness() directly by creating a real Unix socket
 * server that acts as the mock harness.
 */

/** Create a temporary socket path for tests */
function makeSocketPath(): string {
	return `/tmp/iloom-harness-test-${process.pid}-${Date.now()}.sock`
}

/** Start a mock harness socket server that responds with a fixed response */
function startMockHarness(
	socketPath: string,
	handler: (message: Record<string, unknown>) => Record<string, unknown>
): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		const server = net.createServer((socket) => {
			let buffer = ''

			socket.on('data', (chunk: Buffer) => {
				buffer += chunk.toString()
				const newlineIndex = buffer.indexOf('\n')
				if (newlineIndex !== -1) {
					const line = buffer.slice(0, newlineIndex).trim()
					buffer = buffer.slice(newlineIndex + 1)
					try {
						const message = JSON.parse(line) as Record<string, unknown>
						const response = handler(message)
						socket.write(JSON.stringify(response) + '\n')
					} catch {
						socket.write(JSON.stringify({ type: 'error', message: 'invalid JSON' }) + '\n')
					}
				}
			})

			socket.on('error', () => {
				// Ignore socket errors in test harness
			})
		})

		server.listen(socketPath, () => resolve(server))
		server.on('error', reject)
	})
}

/** Stop a mock harness server */
function stopMockHarness(server: net.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()))
}

describe('sendSignalToHarness', () => {
	const servers: net.Server[] = []

	afterEach(async () => {
		for (const server of servers) {
			await stopMockHarness(server)
		}
		servers.length = 0
	})

	describe('successful communication', () => {
		it('should send signal and receive acknowledged response', async () => {
			const socketPath = makeSocketPath()
			const server = await startMockHarness(socketPath, (message) => ({
				type: 'acknowledged',
				echo: message,
			}))
			servers.push(server)

			const response = await sendSignalToHarness(socketPath, { type: 'done' })

			expect(response).toEqual({
				type: 'acknowledged',
				echo: { type: 'done' },
			})
		})

		it('should send signal with data payload', async () => {
			const socketPath = makeSocketPath()
			const server = await startMockHarness(socketPath, (message) => ({
				type: 'acknowledged',
				echo: message,
			}))
			servers.push(server)

			const data = { epicIssueNumber: '42', childIssues: [1, 2, 3] }
			const response = await sendSignalToHarness(socketPath, { type: 'done', data })

			expect(response).toEqual({
				type: 'acknowledged',
				echo: { type: 'done', data },
			})
		})

		it('should return instruction response from harness', async () => {
			const socketPath = makeSocketPath()
			const server = await startMockHarness(socketPath, () => ({
				type: 'instruction',
				content: 'Continue with the next step.',
			}))
			servers.push(server)

			const response = await sendSignalToHarness(socketPath, { type: 'status' })

			expect(response.type).toBe('instruction')
			expect(response.content).toBe('Continue with the next step.')
		})

		it('should send only the type field when data is not provided', async () => {
			const socketPath = makeSocketPath()
			let receivedMessage: Record<string, unknown> = {}
			const server = await startMockHarness(socketPath, (message) => {
				receivedMessage = message
				return { type: 'acknowledged' }
			})
			servers.push(server)

			await sendSignalToHarness(socketPath, { type: 'ping' })

			expect(receivedMessage).toEqual({ type: 'ping' })
			expect(receivedMessage).not.toHaveProperty('data')
		})
	})

	describe('error handling', () => {
		it('should reject when socket does not exist', async () => {
			const socketPath = makeSocketPath()

			await expect(sendSignalToHarness(socketPath, { type: 'done' })).rejects.toThrow()
		})

		it('should reject when harness closes connection without responding', async () => {
			const socketPath = makeSocketPath()
			// Server that closes connection immediately without sending response
			const server = await new Promise<net.Server>((resolve, reject) => {
				const s = net.createServer((socket) => {
					socket.destroy()
				})
				s.listen(socketPath, () => resolve(s))
				s.on('error', reject)
			})
			servers.push(server)

			await expect(sendSignalToHarness(socketPath, { type: 'done' })).rejects.toThrow(
				'Harness closed connection before responding.'
			)
		})

		it('should reject when harness returns invalid JSON', async () => {
			const socketPath = makeSocketPath()
			const server = await new Promise<net.Server>((resolve, reject) => {
				const s = net.createServer((socket) => {
					socket.on('data', () => {
						socket.write('not valid json\n')
					})
				})
				s.listen(socketPath, () => resolve(s))
				s.on('error', reject)
			})
			servers.push(server)

			await expect(sendSignalToHarness(socketPath, { type: 'done' })).rejects.toThrow(
				'Harness returned invalid JSON:'
			)
		})
	})

	describe('timeout behavior', () => {
		it('should reject with timeout error when harness does not respond within 30s', async () => {
			const socketPath = makeSocketPath()

			// Server that accepts but never responds
			const server = await new Promise<net.Server>((resolve, reject) => {
				const s = net.createServer(() => {
					// Intentionally do nothing - simulate unresponsive harness
				})
				s.listen(socketPath, () => resolve(s))
				s.on('error', reject)
			})
			servers.push(server)

			// Use fake timers to control the timeout
			vi.useFakeTimers()
			try {
				// Create the promise first
				const signalPromise = sendSignalToHarness(socketPath, { type: 'done' })

				// Attach rejection handler before advancing timers to prevent unhandled rejection
				const rejection = expect(signalPromise).rejects.toThrow('Harness did not respond within 30s.')

				// Advance past the 30s timeout
				await vi.runAllTimersAsync()

				await rejection
			} finally {
				vi.useRealTimers()
			}
		})
	})
})
