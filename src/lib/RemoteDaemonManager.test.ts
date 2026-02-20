import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import type { ChildProcess } from 'child_process'
import { RemoteDaemonManager } from './RemoteDaemonManager.js'
import type { DaemonConfig } from '../types/remote.js'

// Mock dependencies
vi.mock('fs-extra')
vi.mock('child_process', () => ({
	fork: vi.fn(),
}))

// Mock the logger
vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

// Import after mocking
import { fork } from 'child_process'

describe('RemoteDaemonManager', () => {
	let manager: RemoteDaemonManager
	const testDaemonDir = '/tmp/test-daemon'
	const testPidFile = path.join(testDaemonDir, 'daemon.pid')
	const testLogFile = path.join(testDaemonDir, 'daemon.log')
	const testConfigFile = path.join(testDaemonDir, 'daemon.config.json')
	const testStatusFile = path.join(testDaemonDir, 'daemon.status.json')

	beforeEach(() => {
		manager = new RemoteDaemonManager({
			daemonDir: testDaemonDir,
			pidFile: testPidFile,
			logFile: testLogFile,
			configFile: testConfigFile,
			statusFile: testStatusFile,
		})

		// Reset all mocks
		vi.clearAllMocks()

		// Default mock implementations - use type assertions for fs-extra overloaded types
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
		;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)
		;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockResolvedValue('')
		vi.mocked(fs.unlink).mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('constructor', () => {
		it('should use default paths when no options provided', () => {
			const defaultManager = new RemoteDaemonManager()
			const expectedDir = path.join(os.homedir(), '.config', 'iloom-ai', 'remote-daemon')

			// Access the log file path (public method)
			expect(defaultManager.getLogFilePath()).toBe(path.join(expectedDir, 'daemon.log'))
		})

		it('should use custom paths when options provided', () => {
			expect(manager.getLogFilePath()).toBe(testLogFile)
		})
	})

	describe('start()', () => {
		it('should throw if daemon is already running', async () => {
			// Mock PID file exists with valid PID
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockResolvedValue('12345')

			// Mock process is alive - process.kill returns true but typed as void
			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockReturnValue(true)

			await expect(manager.start({ interval: 300 })).rejects.toThrow(
				'Daemon is already running with PID 12345'
			)

			killSpy.mockRestore()
		})

		it('should create daemon directory with restrictive permissions (0o700)', async () => {
			// Mock no existing PID file
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			// Mock fork to return a child process
			const mockChild = {
				pid: 99999,
				unref: vi.fn(),
				disconnect: vi.fn(),
			}
			vi.mocked(fork).mockReturnValue(mockChild as unknown as ChildProcess)

			await manager.start({ interval: 300 })

			// Daemon directory should use 0o700 to prevent other users from reading logs
			expect(fs.ensureDir).toHaveBeenCalledWith(testDaemonDir, { mode: 0o700 })
		})

		it('should write PID file on successful start', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			const mockChild = {
				pid: 12345,
				unref: vi.fn(),
				disconnect: vi.fn(),
			}
			vi.mocked(fork).mockReturnValue(mockChild as unknown as ChildProcess)

			await manager.start({ interval: 300 })

			expect(fs.writeFile).toHaveBeenCalledWith(
				testPidFile,
				'12345',
				{ mode: 0o644 }
			)
		})

		it('should spawn detached child process', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			const mockChild = {
				pid: 12345,
				unref: vi.fn(),
				disconnect: vi.fn(),
			}
			vi.mocked(fork).mockReturnValue(mockChild as unknown as ChildProcess)

			await manager.start({ interval: 300 })

			expect(fork).toHaveBeenCalledWith(
				expect.stringContaining('RemoteDaemonRunner.js'),
				['300'],
				expect.objectContaining({
					detached: true,
					stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
					cwd: testDaemonDir,
				})
			)
			expect(mockChild.unref).toHaveBeenCalled()
		})

		it('should throw if fork returns no PID', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			const mockChild = {
				pid: undefined,
				unref: vi.fn(),
				disconnect: vi.fn(),
			}
			vi.mocked(fork).mockReturnValue(mockChild as unknown as ChildProcess)

			await expect(manager.start({ interval: 300 })).rejects.toThrow(
				'Failed to start daemon: no PID returned'
			)
		})

		it('should write config file with interval and startedAt', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			const mockChild = {
				pid: 12345,
				unref: vi.fn(),
				disconnect: vi.fn(),
			}
			vi.mocked(fork).mockReturnValue(mockChild as unknown as ChildProcess)

			const beforeStart = new Date()
			await manager.start({ interval: 300 })
			const afterStart = new Date()

			// Check that config file was written
			const configWriteCall = vi.mocked(fs.writeFile).mock.calls.find(
				call => call[0] === testConfigFile
			)
			expect(configWriteCall).toBeDefined()

			// Parse the config
			const writtenConfig = JSON.parse(configWriteCall![1] as string) as DaemonConfig
			expect(writtenConfig.interval).toBe(300)

			// Check startedAt is within the expected range
			const startedAt = new Date(writtenConfig.startedAt)
			expect(startedAt.getTime()).toBeGreaterThanOrEqual(beforeStart.getTime())
			expect(startedAt.getTime()).toBeLessThanOrEqual(afterStart.getTime())
		})

		it('should pass environment variables to child process', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			const mockChild = {
				pid: 12345,
				unref: vi.fn(),
				disconnect: vi.fn(),
			}
			vi.mocked(fork).mockReturnValue(mockChild as unknown as ChildProcess)

			await manager.start({ interval: 300 })

			expect(fork).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Array),
				expect.objectContaining({
					env: expect.objectContaining({
						ILOOM_DAEMON_DIR: testDaemonDir,
						ILOOM_DAEMON_LOG_FILE: testLogFile,
						ILOOM_DAEMON_STATUS_FILE: testStatusFile,
					}),
				})
			)
		})
	})

	describe('stop()', () => {
		it('should read PID file and send SIGTERM after validating heartbeat', async () => {
			// Mock PID file and config file exist with valid heartbeat
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile || path === testConfigFile || path === testStatusFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				if (path === testPidFile) return '12345'
				if (path === testConfigFile) {
					return JSON.stringify({
						interval: 300,
						startedAt: new Date(Date.now() - 60000).toISOString(),
					})
				}
				if (path === testStatusFile) {
					return JSON.stringify({
						lastPoll: new Date().toISOString(),
						monitoredLooms: 5,
					})
				}
				return ''
			})

			// Mock process is alive initially, then dies
			let processAlive = true
			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockImplementation((_pid: number, signal?: string | number) => {
				if (signal === 0) {
					if (processAlive) return true
					const error = new Error('ESRCH') as NodeJS.ErrnoException
					error.code = 'ESRCH'
					throw error
				}
				if (signal === 'SIGTERM') {
					processAlive = false
					return true
				}
				return true
			})

			await manager.stop()

			expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM')
			killSpy.mockRestore()
		})

		it('should remove PID file after stopping', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockResolvedValue('12345')

			// Process dies immediately
			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockImplementation((_pid: number, signal?: NodeJS.Signals | number) => {
				if (signal === 0) {
					const error = new Error('ESRCH') as NodeJS.ErrnoException
					error.code = 'ESRCH'
					throw error
				}
				return true
			})

			await manager.stop()

			expect(fs.unlink).toHaveBeenCalledWith(testPidFile)
			killSpy.mockRestore()
		})

		it('should not kill process if heartbeat validation fails (PID recycling protection)', async () => {
			// Mock PID file exists but config file doesn't (stale daemon state)
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				if (path === testPidFile) return '12345'
				return ''
			})

			// Process exists (different process has recycled the PID)
			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockReturnValue(true)

			await manager.stop()

			// Should clean up PID file but NOT send SIGTERM
			expect(fs.unlink).toHaveBeenCalledWith(testPidFile)
			// Signal 0 checks if process exists, but SIGTERM should not be called
			expect(killSpy).toHaveBeenCalledWith(12345, 0)
			expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGTERM')
			killSpy.mockRestore()
		})

		it('should handle case when process already dead', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockResolvedValue('12345')

			// Process is already dead
			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockImplementation(() => {
				const error = new Error('ESRCH') as NodeJS.ErrnoException
				error.code = 'ESRCH'
				throw error
			})

			// Should not throw
			await expect(manager.stop()).resolves.not.toThrow()

			// Should clean up PID file
			expect(fs.unlink).toHaveBeenCalledWith(testPidFile)
			killSpy.mockRestore()
		})

		it('should handle case when no PID file exists', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			// Should not throw and should not try to kill anything
			const killSpy = vi.spyOn(process, 'kill')
			await expect(manager.stop()).resolves.not.toThrow()
			expect(killSpy).not.toHaveBeenCalled()
			killSpy.mockRestore()
		})

		it('should force kill after timeout', async () => {
			// Mock valid heartbeat state
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile || path === testConfigFile || path === testStatusFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				if (path === testPidFile) return '12345'
				if (path === testConfigFile) {
					return JSON.stringify({
						interval: 300,
						startedAt: new Date(Date.now() - 60000).toISOString(),
					})
				}
				if (path === testStatusFile) {
					return JSON.stringify({
						lastPoll: new Date().toISOString(),
						monitoredLooms: 5,
					})
				}
				return ''
			})

			// Process stays alive until SIGKILL
			let receivedSigkill = false
			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockImplementation((_pid: number, signal?: string | number) => {
				if (signal === 0) {
					// After SIGKILL, die
					if (receivedSigkill) {
						const error = new Error('ESRCH') as NodeJS.ErrnoException
						error.code = 'ESRCH'
						throw error
					}
					// Process stays alive during SIGTERM wait
					return true
				}
				if (signal === 'SIGKILL') {
					receivedSigkill = true
					return true
				}
				return true
			})

			await manager.stop()

			expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL')
			killSpy.mockRestore()
		})
	})

	describe('status()', () => {
		it('should return running=true with PID when daemon active', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile || path === testConfigFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				if (path === testPidFile) return '12345'
				if (path === testConfigFile) {
					return JSON.stringify({
						interval: 300,
						startedAt: new Date(Date.now() - 60000).toISOString(), // 60 seconds ago
					})
				}
				return ''
			})

			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockReturnValue(true)

			const status = await manager.status()

			expect(status.running).toBe(true)
			expect(status.pid).toBe(12345)
			expect(status.interval).toBe(300)
			expect(status.uptime).toBeGreaterThanOrEqual(59)
			expect(status.uptime).toBeLessThanOrEqual(61)

			killSpy.mockRestore()
		})

		it('should return running=false when no PID file', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			const status = await manager.status()

			expect(status.running).toBe(false)
			expect(status.pid).toBeUndefined()
		})

		it('should return running=false when process dead (stale PID)', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockResolvedValue('12345')

			// Process is dead
			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockImplementation(() => {
				const error = new Error('ESRCH') as NodeJS.ErrnoException
				error.code = 'ESRCH'
				throw error
			})

			const status = await manager.status()

			expect(status.running).toBe(false)
			// Should have cleaned up stale PID file
			expect(fs.unlink).toHaveBeenCalledWith(testPidFile)

			killSpy.mockRestore()
		})

		it('should include uptime when running', async () => {
			const startTime = new Date(Date.now() - 3600000) // 1 hour ago

			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile || path === testConfigFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				if (path === testPidFile) return '12345'
				if (path === testConfigFile) {
					return JSON.stringify({
						interval: 300,
						startedAt: startTime.toISOString(),
					})
				}
				return ''
			})

			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockReturnValue(true)

			const status = await manager.status()

			expect(status.running).toBe(true)
			// Uptime should be approximately 3600 seconds (1 hour)
			expect(status.uptime).toBeGreaterThanOrEqual(3599)
			expect(status.uptime).toBeLessThanOrEqual(3601)

			killSpy.mockRestore()
		})

		it('should include lastPoll from status file when available', async () => {
			const lastPollTime = new Date(Date.now() - 120000) // 2 minutes ago

			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				if (path === testPidFile) return '12345'
				if (path === testConfigFile) {
					return JSON.stringify({
						interval: 300,
						startedAt: new Date(Date.now() - 3600000).toISOString(),
					})
				}
				if (path === testStatusFile) {
					return JSON.stringify({
						lastPoll: lastPollTime.toISOString(),
						monitoredLooms: 5,
						lastPollResult: {
							checked: 5,
							cleaned: 1,
							skipped: 0,
							errors: [],
							timestamp: lastPollTime,
						},
					})
				}
				return ''
			})

			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockReturnValue(true)

			const status = await manager.status()

			expect(status.running).toBe(true)
			expect(status.lastPoll).toEqual(lastPollTime)
			expect(status.monitoredLooms).toBe(5)
			expect(status.lastPollResult?.checked).toBe(5)
			expect(status.lastPollResult?.cleaned).toBe(1)

			killSpy.mockRestore()
		})
	})

	describe('isRunning()', () => {
		it('should return true when process exists via kill(pid, 0)', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockResolvedValue('12345')

			// Process exists
			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockReturnValue(true)

			const running = await manager.isRunning()

			expect(running).toBe(true)
			expect(killSpy).toHaveBeenCalledWith(12345, 0)

			killSpy.mockRestore()
		})

		it('should return false when process does not exist', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockResolvedValue('12345')

			// Process doesn't exist
			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockImplementation(() => {
				const error = new Error('ESRCH') as NodeJS.ErrnoException
				error.code = 'ESRCH'
				throw error
			})

			const running = await manager.isRunning()

			expect(running).toBe(false)

			killSpy.mockRestore()
		})

		it('should return true when EPERM (process exists but no permission)', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testPidFile
			})
			;(vi.mocked(fs.readFile) as ReturnType<typeof vi.fn>).mockResolvedValue('12345')

			// Process exists but we don't have permission
			const killSpy = (vi.spyOn(process, 'kill') as ReturnType<typeof vi.fn>).mockImplementation(() => {
				const error = new Error('EPERM') as NodeJS.ErrnoException
				error.code = 'EPERM'
				throw error
			})

			const running = await manager.isRunning()

			expect(running).toBe(true)

			killSpy.mockRestore()
		})

		it('should return false when no PID file exists', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			const running = await manager.isRunning()

			expect(running).toBe(false)
		})
	})

	describe('readLogs()', () => {
		it('should return last N lines from log file', async () => {
			const logContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5'

			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testLogFile
			})
			vi.mocked(fs.readFile).mockResolvedValue(logContent)

			const logs = await manager.readLogs(3)

			expect(logs).toEqual(['Line 3', 'Line 4', 'Line 5'])
		})

		it('should return empty array if log file does not exist', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(false)

			const logs = await manager.readLogs()

			expect(logs).toEqual([])
		})

		it('should filter out empty lines', async () => {
			const logContent = 'Line 1\n\nLine 2\n\n\nLine 3\n'

			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testLogFile
			})
			vi.mocked(fs.readFile).mockResolvedValue(logContent)

			const logs = await manager.readLogs(10)

			expect(logs).toEqual(['Line 1', 'Line 2', 'Line 3'])
		})

		it('should default to 50 lines if not specified', async () => {
			// Create 100 lines
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`)
			const logContent = lines.join('\n')

			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockImplementation(async (path) => {
				return path === testLogFile
			})
			vi.mocked(fs.readFile).mockResolvedValue(logContent)

			const logs = await manager.readLogs()

			expect(logs).toHaveLength(50)
			expect(logs[0]).toBe('Line 51')
			expect(logs[49]).toBe('Line 100')
		})
	})

	describe('getLogFilePath()', () => {
		it('should return the log file path', () => {
			expect(manager.getLogFilePath()).toBe(testLogFile)
		})
	})

	describe('followLogs()', () => {
		it('should output existing lines first', async () => {
			const logContent = 'Line 1\nLine 2\nLine 3'
			const receivedLines: string[] = []

			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue(logContent)
			vi.mocked(fs.stat).mockResolvedValue({ size: logContent.length } as fs.Stats)

			// Mock fs.watch to return a mock watcher
			const mockWatcher = { close: vi.fn() }
			vi.mocked(fs.watch).mockReturnValue(mockWatcher as never)

			const cleanup = await manager.followLogs((line) => {
				receivedLines.push(line)
			}, 10)

			expect(receivedLines).toEqual(['Line 1', 'Line 2', 'Line 3'])
			expect(fs.watch).toHaveBeenCalledWith(testLogFile, expect.any(Function))

			cleanup()
			expect(mockWatcher.close).toHaveBeenCalled()
		})

		it('should create log file if it does not exist', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true)
			vi.mocked(fs.readFile).mockResolvedValue('')
			vi.mocked(fs.stat).mockResolvedValue({ size: 0 } as fs.Stats)

			const mockWatcher = { close: vi.fn() }
			vi.mocked(fs.watch).mockReturnValue(mockWatcher as never)

			const cleanup = await manager.followLogs(() => {}, 10)

			expect(fs.ensureDir).toHaveBeenCalledWith(testDaemonDir)
			expect(fs.writeFile).toHaveBeenCalledWith(testLogFile, '', { mode: 0o644 })

			cleanup()
		})

		it('should respect initialLines parameter', async () => {
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`)
			const logContent = lines.join('\n')
			const receivedLines: string[] = []

			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue(logContent)
			vi.mocked(fs.stat).mockResolvedValue({ size: logContent.length } as fs.Stats)

			const mockWatcher = { close: vi.fn() }
			vi.mocked(fs.watch).mockReturnValue(mockWatcher as never)

			const cleanup = await manager.followLogs((line) => {
				receivedLines.push(line)
			}, 5)

			// Should only get last 5 lines
			expect(receivedLines).toHaveLength(5)
			expect(receivedLines[0]).toBe('Line 96')
			expect(receivedLines[4]).toBe('Line 100')

			cleanup()
		})

		it('should stream new lines when file changes', async () => {
			const initialContent = 'Line 1\nLine 2'
			const fullContent = 'Line 1\nLine 2\nLine 3\nLine 4'
			const receivedLines: string[] = []
			let watchCallback: ((eventType: string) => void) | null = null

			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(true)

			// First read call returns initial content, subsequent calls return full content
			let readCallCount = 0
			vi.mocked(fs.readFile).mockImplementation(async () => {
				readCallCount++
				if (readCallCount <= 1) {
					return initialContent
				}
				return fullContent
			})

			// First stat call returns initial size, subsequent calls return new size
			let statCallCount = 0
			vi.mocked(fs.stat).mockImplementation(async () => {
				statCallCount++
				if (statCallCount === 1) {
					return { size: initialContent.length } as fs.Stats
				}
				return { size: fullContent.length } as fs.Stats
			})

			const mockWatcher = { close: vi.fn() }
			vi.mocked(fs.watch).mockImplementation((_path, callback) => {
				watchCallback = callback as (eventType: string) => void
				return mockWatcher as never
			})

			const cleanup = await manager.followLogs((line) => {
				receivedLines.push(line)
			}, 10)

			// Initial lines should be received
			expect(receivedLines).toEqual(['Line 1', 'Line 2'])

			// Simulate file change event
			if (watchCallback) {
				await watchCallback('change')
			}

			// Wait for async processing
			await new Promise(resolve => globalThis.setTimeout(resolve, 10))

			// New lines should be received
			expect(receivedLines).toEqual(['Line 1', 'Line 2', 'Line 3', 'Line 4'])

			cleanup()
		})

		it('should return cleanup function that closes watcher', async () => {
			;(vi.mocked(fs.pathExists) as ReturnType<typeof vi.fn>).mockResolvedValue(true)
			vi.mocked(fs.readFile).mockResolvedValue('')
			vi.mocked(fs.stat).mockResolvedValue({ size: 0 } as fs.Stats)

			const mockWatcher = { close: vi.fn() }
			vi.mocked(fs.watch).mockReturnValue(mockWatcher as never)

			const cleanup = await manager.followLogs(() => {}, 10)

			expect(mockWatcher.close).not.toHaveBeenCalled()

			cleanup()

			expect(mockWatcher.close).toHaveBeenCalledTimes(1)
		})
	})
})
