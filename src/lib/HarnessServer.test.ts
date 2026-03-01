import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import net from 'net'
import fs from 'fs'
import { setTimeout } from 'timers'
import { HarnessServer } from './HarnessServer.js'
import type { HarnessResponse } from './HarnessServer.js'

vi.mock('net')
vi.mock('fs')
vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

// ─── Mock helpers ────────────────────────────────────────────────────────────

type MockSocket = net.Socket & {
	simulateData: (data: string) => void
	simulateClose: () => void
	simulateError: (err: Error) => void
}

function createMockSocket(): MockSocket {
	const dataHandlers: ((chunk: Buffer) => void)[] = []
	const closeHandlers: (() => void)[] = []
	const errorHandlers: ((err: Error) => void)[] = []

	const mockSocket = {
		on: vi.fn((event: string, handler: unknown) => {
			if (event === 'data') dataHandlers.push(handler as (chunk: Buffer) => void)
			else if (event === 'close') closeHandlers.push(handler as () => void)
			else if (event === 'error') errorHandlers.push(handler as (err: Error) => void)
			return mockSocket
		}),
		write: vi.fn(),
		destroy: vi.fn(),
		end: vi.fn(),
		simulateData: (data: string) => {
			for (const h of dataHandlers) h(Buffer.from(data))
		},
		simulateClose: () => {
			for (const h of closeHandlers) h()
		},
		simulateError: (err: Error) => {
			for (const h of errorHandlers) h(err)
		},
	} as unknown as MockSocket

	return mockSocket
}

type MockServer = {
	listen: ReturnType<typeof vi.fn>
	close: ReturnType<typeof vi.fn>
	on: ReturnType<typeof vi.fn>
	once: ReturnType<typeof vi.fn>
	simulateConnection: (socket: net.Socket) => void
	simulateListenError: (err: Error) => void
}

function setupMockServer(): MockServer {
	let capturedConnectionListener: ((socket: net.Socket) => void) | null = null
	let capturedErrorListener: ((err: Error) => void) | null = null

	const mockServer: MockServer = {
		listen: vi.fn((_socketPath: string, callback: () => void) => {
			callback()
			return mockServer
		}),
		close: vi.fn((callback: (err?: Error) => void) => {
			callback()
			return mockServer
		}),
		on: vi.fn().mockReturnThis(),
		once: vi.fn((event: string, handler: unknown) => {
			if (event === 'error') capturedErrorListener = handler as (err: Error) => void
			return mockServer
		}),
		simulateConnection: (socket: net.Socket) => {
			capturedConnectionListener?.(socket)
		},
		simulateListenError: (err: Error) => {
			capturedErrorListener?.(err)
		},
	}

	vi.mocked(net.createServer).mockImplementation((listener?: unknown) => {
		capturedConnectionListener = listener as ((socket: net.Socket) => void) | null
		return mockServer as unknown as net.Server
	})

	return mockServer
}

// Flush all pending micro/macro tasks
function flushAsync(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('HarnessServer', () => {
	let mockServer: MockServer

	beforeEach(() => {
		mockServer = setupMockServer()
		vi.spyOn(process, 'on').mockReturnValue(process)
		vi.spyOn(process, 'off').mockReturnValue(process)
		vi.spyOn(process, 'kill').mockReturnValue(true)
	})

	// ── constructor ────────────────────────────────────────────────────────────

	describe('constructor', () => {
		it('auto-generates socket path when none provided', () => {
			const server = new HarnessServer()
			expect(server.path).toMatch(/iloom-harness-.+\.sock$/)
		})

		it('accepts external socket path', () => {
			const customPath = '/tmp/custom-test.sock'
			const server = new HarnessServer({ socketPath: customPath })
			expect(server.path).toBe(customPath)
		})
	})

	// ── start() ────────────────────────────────────────────────────────────────

	describe('start()', () => {
		it('removes stale socket file before binding', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith('/tmp/test.sock', { force: true })
		})

		it('creates server and listens on the socket path', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			expect(net.createServer).toHaveBeenCalled()
			expect(mockServer.listen).toHaveBeenCalledWith('/tmp/test.sock', expect.any(Function))
		})

		it('sets socket permissions to 0o600 after listening', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			expect(vi.mocked(fs.chmodSync)).toHaveBeenCalledWith('/tmp/test.sock', 0o600)
		})

		it('registers SIGINT and SIGTERM handlers for cleanup', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			expect(process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
		})

		it('throws if already started', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			await expect(server.start()).rejects.toThrow('HarnessServer is already started')
		})

		it('rejects if listen emits an error', async () => {
			const listenError = new Error('EACCES')
			mockServer.listen = vi.fn((_socketPath: string, _callback: () => void) => {
				// Don't call callback — error will fire via once('error', ...)
				return mockServer
			})

			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			const startPromise = server.start()
			mockServer.simulateListenError(listenError)
			await expect(startPromise).rejects.toThrow('EACCES')
		})
	})

	// ── stop() ─────────────────────────────────────────────────────────────────

	describe('stop()', () => {
		it('closes server and removes socket file', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			vi.mocked(fs.rmSync).mockClear()

			await server.stop()

			expect(mockServer.close).toHaveBeenCalled()
			expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith('/tmp/test.sock', { force: true })
		})

		it('destroys all active connections', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()

			const socket1 = createMockSocket()
			const socket2 = createMockSocket()
			mockServer.simulateConnection(socket1 as unknown as net.Socket)
			mockServer.simulateConnection(socket2 as unknown as net.Socket)

			await server.stop()

			expect(socket1.destroy).toHaveBeenCalled()
			expect(socket2.destroy).toHaveBeenCalled()
		})

		it('removes SIGINT and SIGTERM handlers on stop', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			await server.stop()

			expect(process.off).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(process.off).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
		})

		it('is idempotent (safe to call multiple times)', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			await server.stop()

			// Second stop should not throw and should not call close again
			await expect(server.stop()).resolves.toBeUndefined()
			expect(mockServer.close).toHaveBeenCalledTimes(1)
		})

		it('signal handler calls stop() and re-raises signal when SIGINT fires', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()

			const onCalls = vi.mocked(process.on).mock.calls
			const sigintEntry = onCalls.find(([signal]) => signal === 'SIGINT')
			const sigintHandler = sigintEntry?.[1] as ((signal: NodeJS.Signals) => void) | undefined

			expect(sigintHandler).toBeDefined()
			sigintHandler?.('SIGINT')
			await flushAsync()

			// Server was closed via the signal handler calling stop()
			expect(mockServer.close).toHaveBeenCalled()
			// Signal was re-raised to let default handler terminate the process
			expect(process.kill).toHaveBeenCalledWith(process.pid, 'SIGINT')
		})
	})

	// ── registerHandler() ──────────────────────────────────────────────────────

	describe('registerHandler()', () => {
		it('registers a handler for a message type', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()

			const handler = vi.fn((_data: unknown): HarnessResponse => ({ type: 'acknowledged' }))
			server.registerHandler('ping', handler)

			const socket = createMockSocket()
			mockServer.simulateConnection(socket as unknown as net.Socket)
			socket.simulateData('{"type":"ping","data":null}\n')
			await flushAsync()

			expect(handler).toHaveBeenCalledWith(null)

			await server.stop()
		})

		it('overwrites an existing handler for the same type', async () => {
			const server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()

			const handler1 = vi.fn((_data: unknown): HarnessResponse => ({ type: 'acknowledged' }))
			const handler2 = vi.fn(
				(_data: unknown): HarnessResponse => ({ type: 'instruction', content: 'v2' })
			)

			server.registerHandler('ping', handler1)
			server.registerHandler('ping', handler2)

			const socket = createMockSocket()
			mockServer.simulateConnection(socket as unknown as net.Socket)
			socket.simulateData('{"type":"ping"}\n')
			await flushAsync()

			expect(handler1).not.toHaveBeenCalled()
			expect(handler2).toHaveBeenCalled()

			await server.stop()
		})
	})

	// ── message handling ───────────────────────────────────────────────────────

	describe('message handling', () => {
		let server: HarnessServer
		let socket: MockSocket

		beforeEach(async () => {
			server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			socket = createMockSocket()
			mockServer.simulateConnection(socket as unknown as net.Socket)
		})

		afterEach(async () => {
			await server.stop()
		})

		it('routes messages to registered handlers by type and sends response', async () => {
			const handler = vi.fn(
				(_data: unknown): HarnessResponse => ({ type: 'instruction', content: 'hello' })
			)
			server.registerHandler('greet', handler)

			socket.simulateData('{"type":"greet","data":{"name":"world"}}\n')
			await flushAsync()

			expect(handler).toHaveBeenCalledWith({ name: 'world' })
			const written = JSON.parse(
				vi.mocked(socket.write).mock.calls[0][0] as string
			) as HarnessResponse
			expect(written).toEqual({ type: 'instruction', content: 'hello' })
		})

		it('returns error response for unknown message types', async () => {
			socket.simulateData('{"type":"unknown-type"}\n')
			await flushAsync()

			const written = JSON.parse(
				vi.mocked(socket.write).mock.calls[0][0] as string
			) as HarnessResponse
			expect(written.type).toBe('error')
			expect(written.content).toContain('unknown-type')
		})

		it('returns error response for malformed JSON', async () => {
			socket.simulateData('not valid json\n')
			await flushAsync()

			const written = JSON.parse(
				vi.mocked(socket.write).mock.calls[0][0] as string
			) as HarnessResponse
			expect(written.type).toBe('error')
			expect(written.content).toBe('Malformed JSON')
		})

		it('handles messages split across multiple data chunks', async () => {
			const handler = vi.fn((_data: unknown): HarnessResponse => ({ type: 'acknowledged' }))
			server.registerHandler('chunked', handler)

			// Send message in two parts (no newline in first chunk)
			socket.simulateData('{"type":"chunked","data"')
			socket.simulateData(':"payload"}\n')
			await flushAsync()

			expect(handler).toHaveBeenCalledWith('payload')
		})

		it('handles multiple messages in a single chunk', async () => {
			const handler = vi.fn((_data: unknown): HarnessResponse => ({ type: 'acknowledged' }))
			server.registerHandler('a', handler)
			server.registerHandler('b', handler)

			socket.simulateData('{"type":"a","data":1}\n{"type":"b","data":2}\n')
			await flushAsync()

			expect(handler).toHaveBeenCalledTimes(2)
		})

		it('ignores empty lines in the data stream', async () => {
			const handler = vi.fn((_data: unknown): HarnessResponse => ({ type: 'acknowledged' }))
			server.registerHandler('test', handler)

			// Extra newlines (empty lines) between messages
			socket.simulateData('\n\n{"type":"test"}\n\n')
			await flushAsync()

			expect(handler).toHaveBeenCalledTimes(1)
		})

		it('removes connection from set when socket closes', async () => {
			// Simulate close — removes socket from connections set
			socket.simulateClose()

			// Stop the server; the already-closed socket should not be destroyed again
			await server.stop()
			expect(socket.destroy).not.toHaveBeenCalled()
		})

		it('logs debug message on socket error', async () => {
			const { logger } = await import('../utils/logger.js')
			socket.simulateError(new Error('ECONNRESET'))
			await flushAsync()

			expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
				expect.stringContaining('ECONNRESET')
			)
		})

		it('supports async handlers', async () => {
			const handler = vi.fn(
				(_data: unknown): Promise<HarnessResponse> =>
					Promise.resolve({ type: 'instruction', content: 'async result' })
			)
			server.registerHandler('async-op', handler)

			socket.simulateData('{"type":"async-op"}\n')
			await flushAsync()

			const written = JSON.parse(
				vi.mocked(socket.write).mock.calls[0][0] as string
			) as HarnessResponse
			expect(written).toEqual({ type: 'instruction', content: 'async result' })
		})
	})

	// ── idempotent done handling ───────────────────────────────────────────────

	describe('idempotent handling', () => {
		let server: HarnessServer
		let socket: MockSocket

		beforeEach(async () => {
			server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			socket = createMockSocket()
			mockServer.simulateConnection(socket as unknown as net.Socket)
		})

		afterEach(async () => {
			await server.stop()
		})

		it('first signal of an idempotent type calls handler and returns its response', async () => {
			const handler = vi.fn(
				(_data: unknown): HarnessResponse => ({
					type: 'instruction',
					content: 'Planning complete',
				})
			)
			server.registerHandler('done', handler, { idempotent: true })

			socket.simulateData('{"type":"done","data":{"epicIssue":"42"}}\n')
			await flushAsync()

			expect(handler).toHaveBeenCalledTimes(1)
			expect(handler).toHaveBeenCalledWith({ epicIssue: '42' })
			const written = JSON.parse(
				vi.mocked(socket.write).mock.calls[0][0] as string
			) as HarnessResponse
			expect(written).toEqual({ type: 'instruction', content: 'Planning complete' })
		})

		it('duplicate signal of idempotent type returns acknowledged without calling handler again', async () => {
			const handler = vi.fn(
				(_data: unknown): HarnessResponse => ({ type: 'instruction', content: 'done' })
			)
			server.registerHandler('done', handler, { idempotent: true })

			socket.simulateData('{"type":"done"}\n')
			await flushAsync()

			socket.simulateData('{"type":"done"}\n')
			await flushAsync()

			expect(handler).toHaveBeenCalledTimes(1)

			const writeCalls = vi.mocked(socket.write).mock.calls
			const secondResponse = JSON.parse(writeCalls[1][0] as string) as HarnessResponse
			expect(secondResponse.type).toBe('acknowledged')
		})

		it('non-idempotent handler is called on every invocation', async () => {
			const handler = vi.fn(
				(_data: unknown): HarnessResponse => ({ type: 'acknowledged' })
			)
			server.registerHandler('status', handler)

			socket.simulateData('{"type":"status"}\n')
			await flushAsync()

			socket.simulateData('{"type":"status"}\n')
			await flushAsync()

			expect(handler).toHaveBeenCalledTimes(2)
		})
	})

	// ── waitFor() ──────────────────────────────────────────────────────────────

	describe('waitFor()', () => {
		let server: HarnessServer
		let socket: MockSocket

		beforeEach(async () => {
			server = new HarnessServer({ socketPath: '/tmp/test.sock' })
			await server.start()
			socket = createMockSocket()
			mockServer.simulateConnection(socket as unknown as net.Socket)
		})

		afterEach(async () => {
			await server.stop()
		})

		it('resolves with message data when matching type arrives', async () => {
			server.registerHandler('ready', (): HarnessResponse => ({ type: 'acknowledged' }))

			const waitPromise = server.waitFor('ready')
			socket.simulateData('{"type":"ready","data":{"status":"ok"}}\n')
			await flushAsync()

			await expect(waitPromise).resolves.toEqual({ status: 'ok' })
		})

		it('resolves with undefined when message has no data field', async () => {
			server.registerHandler('ready', (): HarnessResponse => ({ type: 'acknowledged' }))

			const waitPromise = server.waitFor('ready')
			socket.simulateData('{"type":"ready"}\n')
			await flushAsync()

			await expect(waitPromise).resolves.toBeUndefined()
		})

		it('multiple waitFor calls for same type all resolve when message arrives', async () => {
			server.registerHandler('ready', (): HarnessResponse => ({ type: 'acknowledged' }))

			const p1 = server.waitFor('ready')
			const p2 = server.waitFor('ready')

			socket.simulateData('{"type":"ready","data":42}\n')
			await flushAsync()

			await expect(p1).resolves.toBe(42)
			await expect(p2).resolves.toBe(42)
		})

		it('resolves new waiters registered after idempotent duplicate signals', async () => {
			server.registerHandler('done', (): HarnessResponse => ({ type: 'acknowledged' }), { idempotent: true })

			// First signal — resolves first waiter, handler called
			const p1 = server.waitFor('done')
			socket.simulateData('{"type":"done","data":"first"}\n')
			await flushAsync()
			await expect(p1).resolves.toBe('first')

			// Second (duplicate) signal — new waiter still resolves
			const p2 = server.waitFor('done')
			socket.simulateData('{"type":"done","data":"second"}\n')
			await flushAsync()
			await expect(p2).resolves.toBe('second')
		})
	})
})
