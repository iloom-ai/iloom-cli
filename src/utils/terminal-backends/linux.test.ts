import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execa } from 'execa'
import { LinuxBackend, detectLinuxTerminal } from './linux.js'

vi.mock('execa')
vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
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

describe('linux backend', () => {
	describe('detectLinuxTerminal', () => {
		it('should detect gnome-terminal', async () => {
			vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
				if (cmd === 'which' && args?.[0] === 'gnome-terminal') {
					return {} as never
				}
				throw new Error('not found')
			})

			expect(await detectLinuxTerminal()).toBe('gnome-terminal')
		})

		it('should detect konsole when gnome-terminal is not available', async () => {
			vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
				if (cmd === 'which' && args?.[0] === 'konsole') {
					return {} as never
				}
				throw new Error('not found')
			})

			expect(await detectLinuxTerminal()).toBe('konsole')
		})

		it('should detect xterm as fallback', async () => {
			vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
				if (cmd === 'which' && args?.[0] === 'xterm') {
					return {} as never
				}
				throw new Error('not found')
			})

			expect(await detectLinuxTerminal()).toBe('xterm')
		})

		it('should return null when no terminal is available', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('not found'))

			expect(await detectLinuxTerminal()).toBeNull()
		})
	})

	describe('LinuxBackend', () => {
		let backend: LinuxBackend

		beforeEach(() => {
			backend = new LinuxBackend()
		})

		describe('openSingle', () => {
			it('should open gnome-terminal with --tab', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'which' && args?.[0] === 'gnome-terminal') {
						return {} as never
					}
					if (cmd === 'gnome-terminal') {
						return {} as never
					}
					throw new Error('not found')
				})

				await backend.openSingle({
					command: 'pnpm dev',
					title: 'Dev Server',
				})

				const gnomeCall = vi.mocked(execa).mock.calls.find(
					c => c[0] === 'gnome-terminal'
				)
				expect(gnomeCall).toBeDefined()
				const args = gnomeCall![1] as string[]
				expect(args).toContain('--tab')
				expect(args).toContain('--title')
				expect(args).toContain('Dev Server')
				expect(args).toContain('bash')
			})

			it('should open konsole with --new-tab', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'which' && args?.[0] === 'konsole') {
						return {} as never
					}
					if (cmd === 'konsole') {
						return {} as never
					}
					throw new Error('not found')
				})

				await backend.openSingle({
					command: 'pnpm dev',
					title: 'Dev Server',
				})

				const konsoleCall = vi.mocked(execa).mock.calls.find(
					c => c[0] === 'konsole'
				)
				expect(konsoleCall).toBeDefined()
				const args = konsoleCall![1] as string[]
				expect(args).toContain('--new-tab')
				expect(args).toContain('-p')
				expect(args).toContain('tabtitle=Dev Server')
			})

			it('should open xterm as fallback', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'which' && args?.[0] === 'xterm') {
						return {} as never
					}
					if (cmd === 'xterm') {
						return {} as never
					}
					throw new Error('not found')
				})

				await backend.openSingle({
					command: 'pnpm dev',
					title: 'Dev Server',
				})

				const xtermCall = vi.mocked(execa).mock.calls.find(
					c => c[0] === 'xterm'
				)
				expect(xtermCall).toBeDefined()
				const args = xtermCall![1] as string[]
				expect(args).toContain('-title')
				expect(args).toContain('Dev Server')
			})

			it('should throw when no terminal emulator is found', async () => {
				vi.mocked(execa).mockRejectedValue(new Error('not found'))

				await expect(backend.openSingle({ command: 'test' })).rejects.toThrow(
					'No supported terminal emulator found'
				)
			})

			it('should append exec bash to keep terminal open', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'which' && args?.[0] === 'gnome-terminal') {
						return {} as never
					}
					if (cmd === 'gnome-terminal') {
						return {} as never
					}
					throw new Error('not found')
				})

				await backend.openSingle({ command: 'echo hello' })

				const gnomeCall = vi.mocked(execa).mock.calls.find(
					c => c[0] === 'gnome-terminal'
				)
				const args = gnomeCall![1] as string[]
				const bashCArg = args[args.length - 1]
				expect(bashCArg).toContain('; exec bash')
			})
		})

		describe('openMultiple', () => {
			it('should throw when no terminal emulator is found', async () => {
				vi.mocked(execa).mockRejectedValue(new Error('not found'))

				await expect(
					backend.openMultiple([
						{ command: 'cmd1' },
						{ command: 'cmd2' },
					])
				).rejects.toThrow('No supported terminal emulator found')
			})

			it('should open gnome-terminal with multiple --tab flags', async () => {
				vi.mocked(execa).mockImplementation(async (cmd: string, args?: readonly string[]) => {
					if (cmd === 'which' && args?.[0] === 'gnome-terminal') {
						return {} as never
					}
					if (cmd === 'gnome-terminal') {
						return {} as never
					}
					throw new Error('not found')
				})

				await backend.openMultiple([
					{ command: 'cmd1', title: 'Tab 1' },
					{ command: 'cmd2', title: 'Tab 2' },
				])

				const gnomeCall = vi.mocked(execa).mock.calls.find(
					c => c[0] === 'gnome-terminal'
				)
				expect(gnomeCall).toBeDefined()
				const args = gnomeCall![1] as string[]
				const tabCount = args.filter(a => a === '--tab').length
				expect(tabCount).toBe(2)
			})
		})
	})
})
