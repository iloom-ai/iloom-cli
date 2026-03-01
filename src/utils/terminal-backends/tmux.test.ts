import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execa } from 'execa'
import { TmuxBackend, isTmuxAvailable } from './tmux.js'

vi.mock('execa')
vi.mock('node:fs', () => ({
	existsSync: vi.fn().mockReturnValue(false),
}))
vi.mock('../logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

describe('tmux backend', () => {
	describe('isTmuxAvailable', () => {
		it('should return true when tmux is found', async () => {
			vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
				if (cmd === 'which' && args?.[0] === 'tmux') {
					return {} as never
				}
				throw new Error('not found')
			})

			expect(await isTmuxAvailable()).toBe(true)
		})

		it('should return false when tmux is not found', async () => {
			vi.mocked(execa).mockRejectedValue(
				Object.assign(new Error('not found'), { exitCode: 1 })
			)

			expect(await isTmuxAvailable()).toBe(false)
		})
	})

	describe('TmuxBackend', () => {
		let backend: TmuxBackend

		beforeEach(() => {
			vi.clearAllMocks()
			backend = new TmuxBackend()
		})

		describe('openSingle', () => {
			it('should create a new tmux session when no iloom session exists', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'tmux' && args?.[0] === 'list-sessions') {
						throw Object.assign(new Error('no server running'), { exitCode: 1 })
					}
					if (cmd === 'tmux' && args?.[0] === 'new-session') {
						return {} as never
					}
					return {} as never
				})

				await backend.openSingle({
					command: 'pnpm dev',
					title: 'Dev Server',
				})

				const newSessionCall = vi.mocked(execa).mock.calls.find(
					c => c[0] === 'tmux' && (c[1] as string[])?.[0] === 'new-session'
				)
				expect(newSessionCall).toBeDefined()
				const args = newSessionCall![1] as string[]
				expect(args).toContain('-d')
				expect(args).toContain('-s')
				expect(args).toContain('-n')
				expect(args).toContain('iloom-Dev-Server')
			})

			it('should add a window to existing iloom session', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'tmux' && args?.[0] === 'list-sessions') {
						return { stdout: 'iloom-test\nother-session' } as never
					}
					if (cmd === 'tmux' && args?.[0] === 'new-window') {
						return {} as never
					}
					return {} as never
				})

				await backend.openSingle({
					command: 'pnpm dev',
					title: 'Dev Server',
				})

				const newWindowCall = vi.mocked(execa).mock.calls.find(
					c => c[0] === 'tmux' && (c[1] as string[])?.[0] === 'new-window'
				)
				expect(newWindowCall).toBeDefined()
				const args = newWindowCall![1] as string[]
				expect(args).toContain('-t')
				expect(args).toContain('iloom-test')
			})

			it('should use bash as default when no command provided', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'tmux' && args?.[0] === 'list-sessions') {
						throw Object.assign(new Error('no server running'), { exitCode: 1 })
					}
					return {} as never
				})

				await backend.openSingle({})

				const newSessionCall = vi.mocked(execa).mock.calls.find(
					c => c[0] === 'tmux' && (c[1] as string[])?.[0] === 'new-session'
				)
				expect(newSessionCall).toBeDefined()
				const args = newSessionCall![1] as string[]
				expect(args[args.length - 1]).toBe('bash')
			})

			it('should throw when tmux command fails', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'tmux' && args?.[0] === 'list-sessions') {
						throw Object.assign(new Error('no server running'), { exitCode: 1 })
					}
					if (cmd === 'tmux' && args?.[0] === 'new-session') {
						throw new Error('tmux error')
					}
					return {} as never
				})

				await expect(backend.openSingle({ command: 'test' })).rejects.toThrow(
					'Failed to create tmux session'
				)
			})
		})

		describe('openMultiple', () => {
			it('should create session with first window then add remaining', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'tmux' && args?.[0] === 'has-session') {
						throw Object.assign(new Error('no such session'), { exitCode: 1 })
					}
					return {} as never
				})

				await backend.openMultiple([
					{ command: 'cmd1', title: 'Window 1' },
					{ command: 'cmd2', title: 'Window 2' },
					{ command: 'cmd3', title: 'Window 3' },
				])

				const tmuxCalls = vi.mocked(execa).mock.calls.filter(c => c[0] === 'tmux')

				// has-session check + new-session + 2 new-window
				const newSessionCalls = tmuxCalls.filter(c => (c[1] as string[])?.[0] === 'new-session')
				const newWindowCalls = tmuxCalls.filter(c => (c[1] as string[])?.[0] === 'new-window')

				expect(newSessionCalls).toHaveLength(1)
				expect(newWindowCalls).toHaveLength(2)
			})

			it('should handle empty options array', async () => {
				await backend.openMultiple([])
				// Should not throw, just return
				expect(execa).not.toHaveBeenCalledWith('tmux', expect.arrayContaining(['new-session']))
			})

			it('should avoid session name collisions', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'tmux' && args?.[0] === 'has-session') {
						return {} as never // session exists
					}
					return {} as never
				})

				await backend.openMultiple([
					{ command: 'cmd1', title: 'Test' },
					{ command: 'cmd2', title: 'Test 2' },
				])

				const newSessionCall = vi.mocked(execa).mock.calls.find(
					c => c[0] === 'tmux' && (c[1] as string[])?.[0] === 'new-session'
				)
				expect(newSessionCall).toBeDefined()
				const args = newSessionCall![1] as string[]
				const sessionNameIndex = args.indexOf('-s') + 1
				// Should have timestamp suffix to avoid collision
				expect(args[sessionNameIndex]).toMatch(/iloom-Test-\d+/)
			})
		})
	})
})
