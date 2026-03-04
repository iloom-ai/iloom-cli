import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import net from 'net'
import { execa } from 'execa'
import {
	ComposeDevServerStrategy,
	findComposeFile,
	type ComposeUtils,
	type ComposePortMapping,
} from './ComposeDevServerStrategy.js'

// Mock dependencies
vi.mock('execa')
vi.mock('net')
vi.mock('fs/promises')

vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

const WORKTREE = '/worktrees/issue-872'
const COMPOSE_FILE = '/worktrees/issue-872/compose.yml'
const OVERRIDE_FILE = '/home/user/.config/iloom-ai/compose-overrides/override-872.yml'

const makeMappings = (overrides: Partial<ComposePortMapping>[] = []): ComposePortMapping[] => [
	{ service: 'web', hostPort: 3000, containerPort: 3000, ...overrides[0] },
]

const makeUtils = (overrides: Partial<ComposeUtils> = {}): ComposeUtils => ({
	parseComposeFile: vi.fn().mockResolvedValue(makeMappings()),
	generateOverrideFile: vi.fn().mockResolvedValue(OVERRIDE_FILE),
	...overrides,
})

describe('findComposeFile', () => {
	it('should return path to compose.yml when it exists', async () => {
		vi.mocked(fs.access).mockImplementation(async (filePath) => {
			if (String(filePath).endsWith('compose.yml')) return undefined
			throw new Error('ENOENT')
		})

		const result = await findComposeFile(WORKTREE)

		expect(result).toBe(`${WORKTREE}/compose.yml`)
	})

	it('should return path to compose.yaml when compose.yml does not exist', async () => {
		vi.mocked(fs.access).mockImplementation(async (filePath) => {
			if (String(filePath).endsWith('compose.yaml')) return undefined
			throw new Error('ENOENT')
		})

		const result = await findComposeFile(WORKTREE)

		expect(result).toBe(`${WORKTREE}/compose.yaml`)
	})

	it('should return path to docker-compose.yml as a fallback', async () => {
		vi.mocked(fs.access).mockImplementation(async (filePath) => {
			if (String(filePath).endsWith('docker-compose.yml')) return undefined
			throw new Error('ENOENT')
		})

		const result = await findComposeFile(WORKTREE)

		expect(result).toBe(`${WORKTREE}/docker-compose.yml`)
	})

	it('should return path to docker-compose.yaml as last resort', async () => {
		vi.mocked(fs.access).mockImplementation(async (filePath) => {
			if (String(filePath).endsWith('docker-compose.yaml')) return undefined
			throw new Error('ENOENT')
		})

		const result = await findComposeFile(WORKTREE)

		expect(result).toBe(`${WORKTREE}/docker-compose.yaml`)
	})

	it('should prefer compose.yml over docker-compose.yml', async () => {
		vi.mocked(fs.access).mockImplementation(async () => undefined) // all exist

		const result = await findComposeFile(WORKTREE)

		// compose.yml is first in the list
		expect(result).toBe(`${WORKTREE}/compose.yml`)
	})

	it('should return null when no compose file exists', async () => {
		vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'))

		const result = await findComposeFile(WORKTREE)

		expect(result).toBeNull()
	})
})

describe('ComposeDevServerStrategy', () => {
	let utils: ComposeUtils
	let strategy: ComposeDevServerStrategy

	beforeEach(() => {
		utils = makeUtils()
		strategy = new ComposeDevServerStrategy(utils)
	})

	// ---------------------------------------------------------------------------
	// buildProjectName
	// ---------------------------------------------------------------------------
	describe('buildProjectName', () => {
		it('should build project name with numeric identifier', () => {
			expect(ComposeDevServerStrategy.buildProjectName(872)).toBe('iloom-872')
		})

		it('should build project name with string identifier', () => {
			expect(ComposeDevServerStrategy.buildProjectName('my-feature')).toBe('iloom-my-feature')
		})
	})

	// ---------------------------------------------------------------------------
	// isStackRunning
	// ---------------------------------------------------------------------------
	describe('isStackRunning', () => {
		it('should return true when docker compose ps returns running container IDs', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: 'abc123def456',
			} as never)

			const result = await strategy.isStackRunning('iloom-872')

			expect(result).toBe(true)
			expect(execa).toHaveBeenCalledWith(
				'docker',
				['compose', '--project-name', 'iloom-872', 'ps', '--quiet', '--status', 'running'],
				{ reject: false }
			)
		})

		it('should return false when docker compose ps output is empty', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: '',
			} as never)

			const result = await strategy.isStackRunning('iloom-872')

			expect(result).toBe(false)
		})

		it('should return false when docker compose ps exits with non-zero code', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 1,
				stdout: '',
			} as never)

			const result = await strategy.isStackRunning('iloom-872')

			expect(result).toBe(false)
		})

		it('should return false when execa throws', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('Docker not available'))

			const result = await strategy.isStackRunning('iloom-872')

			expect(result).toBe(false)
		})
	})

	// ---------------------------------------------------------------------------
	// startDetached
	// ---------------------------------------------------------------------------
	describe('startDetached', () => {
		it('should call docker compose up --detach --wait with correct args', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)

			await strategy.startDetached(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872')

			expect(execa).toHaveBeenCalledWith(
				'docker',
				[
					'compose',
					'--project-name', 'iloom-872',
					'-f', COMPOSE_FILE,
					'-f', OVERRIDE_FILE,
					'up', '--detach', '--wait',
				],
				expect.objectContaining({ stdio: 'inherit' })
			)
		})

		it('should forward envOverrides into the compose process environment', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)

			await strategy.startDetached(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872', {
				DATABASE_URL: 'postgres://test',
			})

			expect(execa).toHaveBeenCalledWith(
				'docker',
				expect.any(Array),
				expect.objectContaining({
					env: expect.objectContaining({ DATABASE_URL: 'postgres://test' }),
				})
			)
		})

		it('should throw when docker compose up fails', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('compose up failed'))

			await expect(
				strategy.startDetached(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872')
			).rejects.toThrow('Failed to start compose stack "iloom-872"')
		})
	})

	// ---------------------------------------------------------------------------
	// startForeground
	// ---------------------------------------------------------------------------
	describe('startForeground', () => {
		it('should call docker compose up (without --detach) in foreground mode', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)

			await strategy.startForeground(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872')

			const call = vi.mocked(execa).mock.calls[0]
			expect(call[1]).toContain('up')
			expect(call[1]).not.toContain('--detach')
		})

		it('should use stderr stdio when redirectToStderr is true', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)

			await strategy.startForeground(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872', {
				redirectToStderr: true,
			})

			expect(execa).toHaveBeenCalledWith(
				'docker',
				expect.any(Array),
				expect.objectContaining({
					stdio: [process.stdin, process.stderr, process.stderr],
				})
			)
		})

		it('should call onProcessStarted with undefined (no host PID for compose)', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
			const onStart = vi.fn()

			await strategy.startForeground(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872', {
				onProcessStarted: onStart,
			})

			expect(onStart).toHaveBeenCalledWith(undefined)
		})

		it('should set up SIGINT and SIGTERM signal handlers', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
			const onSpy = vi.spyOn(process, 'on')

			await strategy.startForeground(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872')

			expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
		})

		it('should remove signal handlers after completion', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
			const removeSpy = vi.spyOn(process, 'removeListener')

			await strategy.startForeground(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872')

			expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
		})

		it('should remove signal handlers even when docker compose throws', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('compose crashed'))
			const removeSpy = vi.spyOn(process, 'removeListener')

			await expect(
				strategy.startForeground(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872')
			).rejects.toThrow('compose crashed')

			expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
		})

		it('should return empty object (no host PID)', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)

			const result = await strategy.startForeground(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872')

			expect(result).toEqual({})
		})
	})

	// ---------------------------------------------------------------------------
	// stop
	// ---------------------------------------------------------------------------
	describe('stop', () => {
		it('should call docker compose down when stack is running', async () => {
			// isStackRunning returns true (running IDs)
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123' } as never) // ps --quiet
				.mockResolvedValueOnce({ exitCode: 0 } as never) // compose down

			const result = await strategy.stop(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872')

			expect(result).toBe(true)
			expect(execa).toHaveBeenLastCalledWith(
				'docker',
				[
					'compose',
					'--project-name', 'iloom-872',
					'-f', COMPOSE_FILE,
					'-f', OVERRIDE_FILE,
					'down',
				],
				{ reject: false }
			)
		})

		it('should return false and skip down when stack is not running', async () => {
			// isStackRunning returns false (empty output)
			vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '' } as never)

			const result = await strategy.stop(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872')

			expect(result).toBe(false)
			// Should only have called ps, not down
			expect(execa).toHaveBeenCalledTimes(1)
		})

		it('should throw when docker compose down fails unexpectedly', async () => {
			// isStackRunning returns true
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123' } as never) // ps --quiet
				.mockRejectedValueOnce(new Error('daemon unavailable')) // compose down

			await expect(
				strategy.stop(COMPOSE_FILE, OVERRIDE_FILE, 'iloom-872')
			).rejects.toThrow('Failed to stop compose stack "iloom-872"')
		})
	})

	// ---------------------------------------------------------------------------
	// prepareOverrideFile
	// ---------------------------------------------------------------------------
	describe('prepareOverrideFile', () => {
		it('should parse compose file and generate override with remapped host port', async () => {
			const mappings: ComposePortMapping[] = [
				{ service: 'web', hostPort: 3000, containerPort: 3000 },
				{ service: 'db', hostPort: 5432, containerPort: 5432 },
			]
			vi.mocked(utils.parseComposeFile).mockResolvedValue(mappings)
			vi.mocked(utils.generateOverrideFile).mockResolvedValue(OVERRIDE_FILE)

			const result = await strategy.prepareOverrideFile(COMPOSE_FILE, '872', 3872, '/data')

			expect(utils.parseComposeFile).toHaveBeenCalledWith(COMPOSE_FILE)
			// Primary service's host port should be remapped to 3872
			expect(utils.generateOverrideFile).toHaveBeenCalledWith(
				[
					{ service: 'web', hostPort: 3872, containerPort: 3000 },
					{ service: 'db', hostPort: 5432, containerPort: 5432 },
				],
				'872',
				'/data'
			)
			expect(result).toBe(OVERRIDE_FILE)
		})

		it('should throw when compose file has no port mappings', async () => {
			vi.mocked(utils.parseComposeFile).mockResolvedValue([])

			await expect(
				strategy.prepareOverrideFile(COMPOSE_FILE, '872', 3872, '/data')
			).rejects.toThrow('No port mappings found')
		})
	})

	// ---------------------------------------------------------------------------
	// waitForReady
	// ---------------------------------------------------------------------------
	describe('waitForReady', () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		const makeSocket = (triggerEvent: 'connect' | 'error') => {
			const socket = {
				once: vi.fn(),
				destroy: vi.fn(),
				setTimeout: vi.fn(),
			}
			socket.once.mockImplementation((event: string, cb: () => void) => {
				if (event === triggerEvent) cb()
				return socket
			})
			return socket
		}

		it('should return true when port accepts connections immediately', async () => {
			vi.mocked(net.createConnection).mockReturnValue(makeSocket('connect') as never)

			const promise = strategy.waitForReady(3872, 5000, 100)
			await vi.runAllTimersAsync()

			const result = await promise
			expect(result).toBe(true)
		})

		it('should return false when timeout expires before port is available', async () => {
			vi.mocked(net.createConnection).mockReturnValue(makeSocket('error') as never)

			const promise = strategy.waitForReady(3872, 200, 50)
			await vi.runAllTimersAsync()

			const result = await promise
			expect(result).toBe(false)
		})

		it('should exit early if compose stack stops before port is ready', async () => {
			vi.mocked(net.createConnection).mockReturnValue(makeSocket('error') as never)

			// Stack stops after second isStackRunning check
			let isRunningCallCount = 0
			vi.mocked(execa).mockImplementation(async () => {
				isRunningCallCount++
				if (isRunningCallCount >= 2) {
					return { exitCode: 0, stdout: '' } as never // stopped
				}
				return { exitCode: 0, stdout: 'abc123' } as never // running
			})

			const promise = strategy.waitForReady(3872, 30000, 50, 'iloom-872')
			await vi.runAllTimersAsync()

			const result = await promise
			expect(result).toBe(false)
		})
	})
})
