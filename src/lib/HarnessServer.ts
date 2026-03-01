import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { logger } from '../utils/logger.js'

export interface HarnessMessage {
	type: string
	data?: unknown
}

export interface HarnessResponse {
	type: 'instruction' | 'acknowledged' | 'error'
	content?: string
}

export type HarnessHandler = (data: unknown) => HarnessResponse | Promise<HarnessResponse>

export interface HarnessServerOptions {
	socketPath?: string
}

export class HarnessServer {
	private server: net.Server | null = null
	private readonly socketPath: string
	private readonly handlers: Map<string, HarnessHandler> = new Map()
	private readonly idempotentTypes: Set<string> = new Set()
	private readonly handledTypes: Set<string> = new Set()
	private readonly connections: Set<net.Socket> = new Set()
	private readonly waiters: Map<string, Array<(data: unknown) => void>> = new Map()
	private readonly boundSignalHandler: (signal: NodeJS.Signals) => void

	constructor(options: HarnessServerOptions = {}) {
		this.socketPath =
			options.socketPath ??
			path.join(os.tmpdir(), `iloom-harness-${randomUUID()}.sock`)
		this.boundSignalHandler = (signal: NodeJS.Signals): void => {
			void this.stop().finally(() => {
				// Re-raise so the default handler terminates the process
				process.kill(process.pid, signal)
			})
		}
	}

	get path(): string {
		return this.socketPath
	}

	registerHandler(type: string, handler: HarnessHandler, options?: { idempotent?: boolean }): void {
		this.handlers.set(type, handler)
		if (options?.idempotent) {
			this.idempotentTypes.add(type)
		}
	}

	async start(): Promise<void> {
		if (this.server !== null) {
			throw new Error('HarnessServer is already started')
		}

		// Remove stale socket file from crashed previous runs
		fs.rmSync(this.socketPath, { force: true })

		const server = net.createServer((socket) => {
			this.handleConnection(socket)
		})
		this.server = server

		await new Promise<void>((resolve, reject) => {
			server.listen(this.socketPath, () => resolve())
			server.once('error', reject)
		})

		// Set socket to owner read/write only
		fs.chmodSync(this.socketPath, 0o600)

		// Register signal handlers for cleanup on process exit
		process.on('SIGINT', this.boundSignalHandler)
		process.on('SIGTERM', this.boundSignalHandler)

		logger.debug(`HarnessServer listening on ${this.socketPath}`)
	}

	async stop(): Promise<void> {
		if (this.server === null) {
			return
		}

		// Destroy all active connections so the server can close
		for (const socket of this.connections) {
			socket.destroy()
		}
		this.connections.clear()

		// Close the server (set to null first for idempotency guard)
		const serverToClose = this.server
		this.server = null

		try {
			await new Promise<void>((resolve, reject) => {
				serverToClose.close((err) => {
					if (err) reject(err)
					else resolve()
				})
			})
		} finally {
			// Cleanup must run even if server.close() rejects
			fs.rmSync(this.socketPath, { force: true })
			this.waiters.clear()
			process.off('SIGINT', this.boundSignalHandler)
			process.off('SIGTERM', this.boundSignalHandler)
			logger.debug('HarnessServer stopped')
		}
	}

	waitFor(type: string): Promise<unknown> {
		return new Promise<unknown>((resolve) => {
			const resolvers = this.waiters.get(type) ?? []
			resolvers.push(resolve)
			this.waiters.set(type, resolvers)
		})
	}

	private handleConnection(socket: net.Socket): void {
		this.connections.add(socket)
		let buffer = ''
		const MAX_BUFFER_SIZE = 1024 * 1024 // 1MB

		socket.on('data', (chunk: Buffer) => {
			buffer += chunk.toString()
			if (buffer.length > MAX_BUFFER_SIZE) {
				socket.destroy(new Error('Payload too large'))
				return
			}
			const lines = buffer.split('\n')
			// Keep the last potentially incomplete segment in the buffer
			buffer = lines.pop() ?? ''
			for (const line of lines) {
				const trimmed = line.trim()
				if (trimmed) {
					void this.processMessage(trimmed, socket)
				}
			}
		})

		socket.on('close', () => {
			this.connections.delete(socket)
		})

		socket.on('error', (err: Error) => {
			logger.debug(`HarnessServer socket error: ${err.message}`)
		})
	}

	private async processMessage(raw: string, socket: net.Socket): Promise<void> {
		let message: HarnessMessage
		try {
			const parsed: unknown = JSON.parse(raw)
			if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).type !== 'string') {
				this.sendResponse(socket, { type: 'error', content: 'Invalid message format' })
				return
			}
			message = parsed as HarnessMessage
		} catch {
			this.sendResponse(socket, { type: 'error', content: 'Malformed JSON' })
			return
		}

		// Resolve any waiters registered for this message type
		const resolvers = this.waiters.get(message.type)
		if (resolvers && resolvers.length > 0) {
			this.waiters.delete(message.type)
			for (const resolve of resolvers) {
				resolve(message.data)
			}
		}

		// Idempotent handling: only applies to handlers registered with { idempotent: true }
		if (this.idempotentTypes.has(message.type) && this.handledTypes.has(message.type)) {
			this.sendResponse(socket, { type: 'acknowledged' })
			return
		}

		// No handler registered for this type
		const handler = this.handlers.get(message.type)
		if (!handler) {
			this.sendResponse(socket, {
				type: 'error',
				content: `No handler registered for type: ${message.type}`,
			})
			return
		}

		// Mark as handled before calling handler (only for idempotent types)
		if (this.idempotentTypes.has(message.type)) {
			this.handledTypes.add(message.type)
		}
		const response = await handler(message.data)
		this.sendResponse(socket, response)
	}

	private sendResponse(socket: net.Socket, response: HarnessResponse): void {
		socket.write(JSON.stringify(response) + '\n')
	}
}
