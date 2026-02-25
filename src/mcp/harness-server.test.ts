import { describe, it, expect, vi, beforeEach } from 'vitest'
import net from 'net'
import { sendSignalToHarness } from './harness-server.js'

vi.mock('net')

/**
 * Tests for the harness MCP server's socket communication logic.
 *
 * Uses mocked net.createConnection to test sendSignalToHarness() without
 * creating real Unix domain sockets.
 */

type MockSocket = {
	on: ReturnType<typeof vi.fn>
	write: ReturnType<typeof vi.fn>
	destroy: ReturnType<typeof vi.fn>
	simulateConnect: () => void
	simulateData: (data: string) => void
	simulateError: (err: NodeJS.ErrnoException) => void
	simulateClose: () => void
}

function createMockSocket(): MockSocket {
	const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}

	const socket: MockSocket = {
		on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			handlers[event] = handlers[event] ?? []
			handlers[event].push(handler)
			return socket
		}),
		write: vi.fn(),
		destroy: vi.fn(),
		simulateConnect: () => {
			for (const h of handlers['connect'] ?? []) h()
		},
		simulateData: (data: string) => {
			for (const h of handlers['data'] ?? []) h(Buffer.from(data))
		},
		simulateError: (err: NodeJS.ErrnoException) => {
			for (const h of handlers['error'] ?? []) h(err)
		},
		simulateClose: () => {
			for (const h of handlers['close'] ?? []) h()
		},
	}

	return socket
}

describe('sendSignalToHarness', () => {
	let mockSocket: MockSocket

	beforeEach(() => {
		mockSocket = createMockSocket()
		vi.mocked(net.createConnection).mockReturnValue(mockSocket as unknown as net.Socket)
	})

	describe('successful communication', () => {
		it('should send signal and receive acknowledged response', async () => {
			const promise = sendSignalToHarness('/tmp/test.sock', { type: 'done' })

			mockSocket.simulateConnect()
			expect(mockSocket.write).toHaveBeenCalledWith('{"type":"done"}\n')

			mockSocket.simulateData('{"type":"acknowledged","echo":{"type":"done"}}\n')

			const response = await promise
			expect(response).toEqual({
				type: 'acknowledged',
				echo: { type: 'done' },
			})
		})

		it('should send signal with data payload', async () => {
			const data = { epicIssueNumber: '42', childIssues: [1, 2, 3] }
			const promise = sendSignalToHarness('/tmp/test.sock', { type: 'done', data })

			mockSocket.simulateConnect()
			expect(mockSocket.write).toHaveBeenCalledWith(
				JSON.stringify({ type: 'done', data }) + '\n'
			)

			mockSocket.simulateData(JSON.stringify({ type: 'acknowledged', echo: { type: 'done', data } }) + '\n')

			const response = await promise
			expect(response).toEqual({
				type: 'acknowledged',
				echo: { type: 'done', data },
			})
		})

		it('should return instruction response from harness', async () => {
			const promise = sendSignalToHarness('/tmp/test.sock', { type: 'status' })

			mockSocket.simulateConnect()
			mockSocket.simulateData('{"type":"instruction","content":"Continue with the next step."}\n')

			const response = await promise
			expect(response.type).toBe('instruction')
			expect(response.content).toBe('Continue with the next step.')
		})

		it('should send only the type field when data is not provided', async () => {
			const promise = sendSignalToHarness('/tmp/test.sock', { type: 'ping' })

			mockSocket.simulateConnect()
			const writtenPayload = mockSocket.write.mock.calls[0][0] as string
			const parsed = JSON.parse(writtenPayload.trim()) as Record<string, unknown>
			expect(parsed).toEqual({ type: 'ping' })
			expect(parsed).not.toHaveProperty('data')

			mockSocket.simulateData('{"type":"acknowledged"}\n')
			await promise
		})
	})

	describe('error handling', () => {
		it('should reject when socket emits error', async () => {
			const promise = sendSignalToHarness('/tmp/test.sock', { type: 'done' })

			const err = new Error('ENOENT') as NodeJS.ErrnoException
			err.code = 'ENOENT'
			mockSocket.simulateError(err)

			await expect(promise).rejects.toThrow()
		})

		it('should reject when harness closes connection without responding', async () => {
			const promise = sendSignalToHarness('/tmp/test.sock', { type: 'done' })

			mockSocket.simulateConnect()
			mockSocket.simulateClose()

			await expect(promise).rejects.toThrow('Harness closed connection before responding.')
		})

		it('should reject with friendly message for EPIPE errors', async () => {
			const promise = sendSignalToHarness('/tmp/test.sock', { type: 'done' })

			const err = new Error('EPIPE') as NodeJS.ErrnoException
			err.code = 'EPIPE'
			mockSocket.simulateError(err)

			await expect(promise).rejects.toThrow('Harness closed connection before responding.')
		})

		it('should reject when harness returns invalid JSON', async () => {
			const promise = sendSignalToHarness('/tmp/test.sock', { type: 'done' })

			mockSocket.simulateConnect()
			mockSocket.simulateData('not valid json\n')

			await expect(promise).rejects.toThrow('Harness returned invalid JSON:')
		})
	})

	describe('timeout behavior', () => {
		it('should reject with timeout error when harness does not respond within 30s', async () => {
			vi.useFakeTimers()
			try {
				const promise = sendSignalToHarness('/tmp/test.sock', { type: 'done' })
				mockSocket.simulateConnect()

				const rejection = expect(promise).rejects.toThrow('Harness did not respond within 30s.')

				await vi.runAllTimersAsync()

				await rejection
				expect(mockSocket.destroy).toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})
	})
})
