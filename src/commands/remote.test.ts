import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RemoteCommand, DaemonAlreadyRunningError, InvalidActionError } from './remote.js'
import type { DaemonStatus, PollResult } from '../types/remote.js'

// Mock the logger
vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
		debug: vi.fn(),
	},
}))

// Mock RemoteDaemonManager
const mockDaemonManager = {
	start: vi.fn(),
	stop: vi.fn(),
	status: vi.fn(),
	isRunning: vi.fn(),
	readLogs: vi.fn(),
	followLogs: vi.fn(),
	getLogFilePath: vi.fn(),
}

describe('RemoteCommand', () => {
	let command: RemoteCommand

	beforeEach(() => {
		// Reset mocks
		vi.clearAllMocks()
		command = new RemoteCommand(mockDaemonManager as never)
	})

	describe('start action', () => {
		it('should start daemon and return status', async () => {
			mockDaemonManager.isRunning.mockResolvedValue(false)
			mockDaemonManager.start.mockResolvedValue(undefined)
			mockDaemonManager.status.mockResolvedValue({
				running: true,
				pid: 12345,
				interval: 300,
			} as DaemonStatus)

			const result = await command.execute({
				action: 'start',
				options: {},
			})

			expect(result).toEqual({
				running: true,
				pid: 12345,
				interval: 300,
			})
			expect(mockDaemonManager.start).toHaveBeenCalledWith({ interval: 300 })
		})

		it('should use custom interval when provided', async () => {
			mockDaemonManager.isRunning.mockResolvedValue(false)
			mockDaemonManager.start.mockResolvedValue(undefined)
			mockDaemonManager.status.mockResolvedValue({
				running: true,
				pid: 12345,
				interval: 60,
			} as DaemonStatus)

			const result = await command.execute({
				action: 'start',
				options: { interval: 60 },
			})

			expect(result).toEqual({
				running: true,
				pid: 12345,
				interval: 60,
			})
			expect(mockDaemonManager.start).toHaveBeenCalledWith({ interval: 60 })
		})

		it('should throw DaemonAlreadyRunningError if daemon is already running', async () => {
			mockDaemonManager.isRunning.mockResolvedValue(true)
			mockDaemonManager.status.mockResolvedValue({
				running: true,
				pid: 12345,
			} as DaemonStatus)

			await expect(
				command.execute({
					action: 'start',
					options: {},
				})
			).rejects.toThrow(DaemonAlreadyRunningError)

			expect(mockDaemonManager.start).not.toHaveBeenCalled()
		})

		it('should throw on start errors', async () => {
			mockDaemonManager.isRunning.mockResolvedValue(false)
			mockDaemonManager.start.mockRejectedValue(new Error('Fork failed'))

			await expect(
				command.execute({
					action: 'start',
					options: {},
				})
			).rejects.toThrow('Fork failed')
		})
	})

	describe('stop action', () => {
		it('should stop daemon and return stopped status', async () => {
			mockDaemonManager.isRunning.mockResolvedValue(true)
			mockDaemonManager.status.mockResolvedValue({
				running: true,
				pid: 12345,
			} as DaemonStatus)
			mockDaemonManager.stop.mockResolvedValue(undefined)

			const result = await command.execute({
				action: 'stop',
				options: {},
			})

			expect(result).toEqual({ running: false })
			expect(mockDaemonManager.stop).toHaveBeenCalled()
		})

		it('should return stopped status if daemon is not running', async () => {
			mockDaemonManager.isRunning.mockResolvedValue(false)

			const result = await command.execute({
				action: 'stop',
				options: {},
			})

			expect(result).toEqual({ running: false })
			expect(mockDaemonManager.stop).not.toHaveBeenCalled()
		})

		it('should throw on stop errors', async () => {
			mockDaemonManager.isRunning.mockResolvedValue(true)
			mockDaemonManager.status.mockResolvedValue({
				running: true,
				pid: 12345,
			} as DaemonStatus)
			mockDaemonManager.stop.mockRejectedValue(new Error('EPERM'))

			await expect(
				command.execute({
					action: 'stop',
					options: {},
				})
			).rejects.toThrow('EPERM')
		})
	})

	describe('status action', () => {
		it('should return running status with details', async () => {
			const mockStatus: DaemonStatus = {
				running: true,
				pid: 12345,
				uptime: 3600,
				interval: 300,
				lastPoll: new Date('2024-01-15T10:00:00Z'),
				monitoredLooms: 5,
				lastPollResult: {
					checked: 5,
					cleaned: 1,
					skipped: 0,
					errors: [],
					timestamp: new Date('2024-01-15T10:00:00Z'),
				} as PollResult,
			}
			mockDaemonManager.status.mockResolvedValue(mockStatus)

			const result = await command.execute({
				action: 'status',
				options: {},
			})

			expect(result).toEqual(mockStatus)
		})

		it('should return stopped status when not running', async () => {
			mockDaemonManager.status.mockResolvedValue({
				running: false,
			} as DaemonStatus)

			const result = await command.execute({
				action: 'status',
				options: {},
			})

			expect(result).toEqual({ running: false })
		})

		it('should return status when --json flag provided', async () => {
			mockDaemonManager.status.mockResolvedValue({
				running: true,
				pid: 12345,
			} as DaemonStatus)

			const result = await command.execute({
				action: 'status',
				options: { json: true },
			})

			expect(result).toEqual({
				running: true,
				pid: 12345,
			})
		})
	})

	describe('restart action', () => {
		it('should stop and start daemon with new settings', async () => {
			// First call - isRunning returns true (daemon is running)
			// Second call after stop - isRunning would return false
			mockDaemonManager.isRunning.mockResolvedValueOnce(true)
			mockDaemonManager.stop.mockResolvedValue(undefined)
			mockDaemonManager.start.mockResolvedValue(undefined)
			mockDaemonManager.status.mockResolvedValue({
				running: true,
				pid: 12346,
				interval: 60,
			} as DaemonStatus)

			const result = await command.execute({
				action: 'restart',
				options: { interval: 60 },
			})

			expect(result).toEqual({
				running: true,
				pid: 12346,
				interval: 60,
			})
			expect(mockDaemonManager.stop).toHaveBeenCalled()
			expect(mockDaemonManager.start).toHaveBeenCalledWith({ interval: 60 })
		})

		it('should start daemon if not already running', async () => {
			mockDaemonManager.isRunning.mockResolvedValue(false)
			mockDaemonManager.start.mockResolvedValue(undefined)
			mockDaemonManager.status.mockResolvedValue({
				running: true,
				pid: 12345,
				interval: 300,
			} as DaemonStatus)

			const result = await command.execute({
				action: 'restart',
				options: {},
			})

			expect(result).toEqual({
				running: true,
				pid: 12345,
				interval: 300,
			})
			expect(mockDaemonManager.stop).not.toHaveBeenCalled()
			expect(mockDaemonManager.start).toHaveBeenCalled()
		})
	})

	describe('logs action', () => {
		it('should return recent log entries', async () => {
			const mockLogs = [
				'[2024-01-15T10:00:00Z] [INFO] Daemon started',
				'[2024-01-15T10:05:00Z] [INFO] Poll completed: Monitored 5 PRs, cleaned up 1 loom',
			]
			mockDaemonManager.readLogs.mockResolvedValue(mockLogs)

			const result = await command.execute({
				action: 'logs',
				options: {},
			})

			expect(result).toEqual(mockLogs)
			expect(mockDaemonManager.readLogs).toHaveBeenCalledWith(50)
		})

		it('should respect --lines option', async () => {
			mockDaemonManager.readLogs.mockResolvedValue([])

			await command.execute({
				action: 'logs',
				options: { lines: 100 },
			})

			expect(mockDaemonManager.readLogs).toHaveBeenCalledWith(100)
		})

		it('should handle empty logs', async () => {
			mockDaemonManager.readLogs.mockResolvedValue([])

			const result = await command.execute({
				action: 'logs',
				options: {},
			})

			expect(result).toEqual([])
		})
	})

	describe('logs action with --follow', () => {
		it('should call followLogs when --follow flag is set', async () => {
			const mockLines = ['Line 1', 'Line 2']

			// Mock followLogs to emit lines
			mockDaemonManager.followLogs.mockImplementation(async (onLine: (line: string) => void) => {
				// Emit initial lines
				for (const line of mockLines) {
					onLine(line)
				}
				// Return cleanup function
				return () => {}
			})

			// Simulate SIGINT after a short delay
			const executePromise = command.execute({
				action: 'logs',
				options: { follow: true },
			})

			// Give the follow handler time to set up, then trigger SIGINT
			await new Promise(resolve => globalThis.setTimeout(resolve, 10))
			process.emit('SIGINT', 'SIGINT')

			const result = await executePromise

			expect(mockDaemonManager.followLogs).toHaveBeenCalledWith(
				expect.any(Function),
				50 // default lines
			)
			expect(result).toEqual(mockLines)
		})

		it('should respect --lines option with --follow', async () => {
			mockDaemonManager.followLogs.mockImplementation(async () => {
				return () => {}
			})

			const executePromise = command.execute({
				action: 'logs',
				options: { follow: true, lines: 100 },
			})

			await new Promise(resolve => globalThis.setTimeout(resolve, 10))
			process.emit('SIGINT', 'SIGINT')

			await executePromise

			expect(mockDaemonManager.followLogs).toHaveBeenCalledWith(
				expect.any(Function),
				100
			)
		})

		it('should collect lines during follow mode', async () => {
			mockDaemonManager.followLogs.mockImplementation(async (onLine: (line: string) => void) => {
				// Emit some lines
				onLine('Initial line 1')
				onLine('Initial line 2')

				// Simulate new lines coming in after initial load
				globalThis.setTimeout(() => {
					onLine('New line 1')
					onLine('New line 2')
				}, 5)

				return () => {}
			})

			const executePromise = command.execute({
				action: 'logs',
				options: { follow: true, json: true },
			})

			// Wait for initial and delayed lines
			await new Promise(resolve => globalThis.setTimeout(resolve, 20))
			process.emit('SIGINT', 'SIGINT')

			const result = await executePromise

			expect(result).toEqual([
				'Initial line 1',
				'Initial line 2',
				'New line 1',
				'New line 2',
			])
		})

		it('should call cleanup function on SIGINT', async () => {
			const cleanupFn = vi.fn()

			mockDaemonManager.followLogs.mockImplementation(async () => {
				return cleanupFn
			})

			const executePromise = command.execute({
				action: 'logs',
				options: { follow: true },
			})

			await new Promise(resolve => globalThis.setTimeout(resolve, 10))
			process.emit('SIGINT', 'SIGINT')

			await executePromise

			expect(cleanupFn).toHaveBeenCalled()
		})

		it('should call cleanup function on SIGTERM', async () => {
			const cleanupFn = vi.fn()

			mockDaemonManager.followLogs.mockImplementation(async () => {
				return cleanupFn
			})

			const executePromise = command.execute({
				action: 'logs',
				options: { follow: true },
			})

			await new Promise(resolve => globalThis.setTimeout(resolve, 10))
			process.emit('SIGTERM', 'SIGTERM')

			await executePromise

			expect(cleanupFn).toHaveBeenCalled()
		})

		it('should not call readLogs when --follow is used', async () => {
			mockDaemonManager.followLogs.mockImplementation(async () => {
				return () => {}
			})

			const executePromise = command.execute({
				action: 'logs',
				options: { follow: true },
			})

			await new Promise(resolve => globalThis.setTimeout(resolve, 10))
			process.emit('SIGINT', 'SIGINT')

			await executePromise

			expect(mockDaemonManager.readLogs).not.toHaveBeenCalled()
			expect(mockDaemonManager.followLogs).toHaveBeenCalled()
		})
	})

	describe('invalid action', () => {
		it('should throw InvalidActionError for unknown action', async () => {
			await expect(
				command.execute({
					action: 'invalid',
					options: {},
				})
			).rejects.toThrow(InvalidActionError)
		})
	})

	describe('JSON output mode', () => {
		it('should not call logger methods when json=true for start', async () => {
			const { logger } = await import('../utils/logger.js')
			mockDaemonManager.isRunning.mockResolvedValue(false)
			mockDaemonManager.start.mockResolvedValue(undefined)
			mockDaemonManager.status.mockResolvedValue({
				running: true,
				pid: 12345,
			} as DaemonStatus)

			await command.execute({
				action: 'start',
				options: { json: true },
			})

			expect(logger.success).not.toHaveBeenCalled()
			expect(logger.info).not.toHaveBeenCalled()
		})

		it('should not call logger methods when json=true for status', async () => {
			const { logger } = await import('../utils/logger.js')
			mockDaemonManager.status.mockResolvedValue({
				running: true,
				pid: 12345,
			} as DaemonStatus)

			await command.execute({
				action: 'status',
				options: { json: true },
			})

			expect(logger.info).not.toHaveBeenCalled()
		})
	})
})
