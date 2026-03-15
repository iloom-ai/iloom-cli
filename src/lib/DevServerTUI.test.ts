import { describe, it, expect, vi } from 'vitest'
import { DevServerTUI, type DevServerTUIOptions, type DevServerStatus } from './DevServerTUI.js'
import { openBrowser } from '../utils/browser.js'
import { execa } from 'execa'
import { restoreTerminalState } from '../utils/terminal.js'

// Mock dependencies
vi.mock('execa')
vi.mock('../utils/browser.js')
vi.mock('../utils/terminal.js')

vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

/**
 * Create a mock WriteStream for stdout with essential properties.
 */
function createMockStdout() {
	const written: string[] = []
	const stream = {
		rows: 24,
		columns: 80,
		isTTY: true,
		write: vi.fn((data: string) => {
			written.push(data)
			return true
		}),
		on: vi.fn(),
		removeListener: vi.fn(),
	} as unknown as NodeJS.WriteStream
	return { stream, written }
}

/**
 * Create a mock ReadStream for stdin with essential properties.
 */
function createMockStdin() {
	const stream = {
		isTTY: true,
		setRawMode: vi.fn().mockReturnThis(),
		resume: vi.fn(),
		pause: vi.fn(),
		on: vi.fn(),
		once: vi.fn(),
		removeListener: vi.fn(),
	} as unknown as NodeJS.ReadStream
	return stream
}

function createTUI(overrides: Partial<DevServerTUIOptions> = {}) {
	const { stream: stdout, written } = createMockStdout()
	const stdin = createMockStdin()

	const options: DevServerTUIOptions = {
		url: 'http://localhost:3920',
		port: 3920,
		stdout,
		stdin,
		...overrides,
	}

	const tui = new DevServerTUI(options)
	return { tui, stdout, stdin, written }
}

describe('DevServerTUI', () => {
	describe('constructor', () => {
		it('should create instance with required options', () => {
			const { tui } = createTUI()
			expect(tui).toBeDefined()
		})

		it('should accept optional containerPort', () => {
			const { tui } = createTUI({ containerPort: 4200 })
			expect(tui).toBeDefined()
		})
	})

	describe('start', () => {
		it('should set up scroll region and render status bar', () => {
			const { tui, stdout, written } = createTUI()
			tui.start()

			// Should write ANSI sequences: hide cursor, set scroll region, move cursor, render status bar
			expect(stdout.write).toHaveBeenCalled()

			// Check that scroll region was set (rows 1 to rows - 4 = 20)
			const allOutput = written.join('')
			// Scroll region: ESC[1;20r
			expect(allOutput).toContain('\x1b[1;20r')
			// Hide cursor
			expect(allOutput).toContain('\x1b[?25l')
			// Status bar should contain the URL
			expect(allOutput).toContain('http://localhost:3920')

			tui.cleanup()
		})

		it('should enable raw mode on stdin for keyboard input', () => {
			const { tui, stdin } = createTUI()
			tui.start()

			expect(stdin.setRawMode).toHaveBeenCalledWith(true)
			expect(stdin.resume).toHaveBeenCalled()
			expect(stdin.on).toHaveBeenCalledWith('data', expect.any(Function))

			tui.cleanup()
		})

		it('should listen for terminal resize events', () => {
			const { tui, stdout } = createTUI()
			tui.start()

			expect(stdout.on).toHaveBeenCalledWith('resize', expect.any(Function))

			tui.cleanup()
		})

		it('should be idempotent - calling start twice does not double-init', () => {
			const { tui, stdin } = createTUI()
			tui.start()
			tui.start() // second call should be a no-op

			// setRawMode should only be called once (from start), not twice
			expect(stdin.setRawMode).toHaveBeenCalledTimes(1)

			tui.cleanup()
		})
	})

	describe('handleOutput', () => {
		it('should write data to stdout', () => {
			const { tui, written } = createTUI()
			tui.start()

			// Clear recorded writes from start()
			const preStartWrites = written.length

			tui.handleOutput(Buffer.from('Hello world\n'))

			// Should have additional writes after start
			expect(written.length).toBeGreaterThan(preStartWrites)

			// Output should contain the data we sent
			const postStartOutput = written.slice(preStartWrites).join('')
			expect(postStartOutput).toContain('Hello world\n')

			tui.cleanup()
		})

		it('should handle string data', () => {
			const { tui, written } = createTUI()
			tui.start()

			const preStartWrites = written.length

			tui.handleOutput('String output\n')

			const postStartOutput = written.slice(preStartWrites).join('')
			expect(postStartOutput).toContain('String output\n')

			tui.cleanup()
		})

		it('should not write if not started', () => {
			const { tui, stdout } = createTUI()

			// handleOutput before start should be a no-op
			tui.handleOutput(Buffer.from('test'))

			expect(stdout.write).not.toHaveBeenCalled()
		})

		it('should not write if cleaned up', () => {
			const { tui, written } = createTUI()
			tui.start()
			tui.cleanup()

			const postCleanupWrites = written.length
			tui.handleOutput(Buffer.from('test'))

			// No additional writes after cleanup
			expect(written.length).toBe(postCleanupWrites)
		})
	})

	describe('updateStatus', () => {
		it('should re-render status bar with new status', () => {
			const { tui, written } = createTUI()
			tui.start()

			const preUpdateWrites = written.length

			tui.updateStatus('Stopped')

			// Status bar should be re-rendered
			const postUpdateOutput = written.slice(preUpdateWrites).join('')
			expect(postUpdateOutput).toContain('Stopped')
		})

		it('should show correct icon for each status', () => {
			const statuses: Array<{ status: DevServerStatus; icon: string }> = [
				{ status: 'Running', icon: '\u25A0' },   // filled square
				{ status: 'Stopped', icon: '\u25A1' },   // empty square
				{ status: 'Restarting', icon: '\u25C6' }, // diamond
			]

			for (const { status, icon } of statuses) {
				const { tui, written } = createTUI()
				tui.start()

				const preUpdateWrites = written.length
				tui.updateStatus(status)

				const postUpdateOutput = written.slice(preUpdateWrites).join('')
				expect(postUpdateOutput).toContain(icon)
				expect(postUpdateOutput).toContain(status)

				tui.cleanup()
			}
		})
	})

	describe('renderStatusBar', () => {
		it('should display URL in status bar', () => {
			const { tui, written } = createTUI()
			tui.start()

			const allOutput = written.join('')
			expect(allOutput).toContain('http://localhost:3920')
		})

		it('should display port mapping when containerPort is set', () => {
			const { tui, written } = createTUI({ containerPort: 4200 })
			tui.start()

			const allOutput = written.join('')
			// Should contain port mapping: 4200 -> 3920
			expect(allOutput).toContain('4200')
			expect(allOutput).toContain('3920')

			tui.cleanup()
		})

		it('should display single port when no containerPort', () => {
			const { tui, written } = createTUI()
			tui.start()

			const allOutput = written.join('')
			expect(allOutput).toContain('Port 3920')

			tui.cleanup()
		})

		it('should display box-drawing characters', () => {
			const { tui, written } = createTUI()
			tui.start()

			const allOutput = written.join('')
			// Box-drawing characters
			expect(allOutput).toContain('\u250C') // top-left corner
			expect(allOutput).toContain('\u2510') // top-right corner
			expect(allOutput).toContain('\u2514') // bottom-left corner
			expect(allOutput).toContain('\u2518') // bottom-right corner
			expect(allOutput).toContain('\u2500') // horizontal line

			tui.cleanup()
		})

		it('should display keyboard shortcut hints', () => {
			const { tui, written } = createTUI()
			tui.start()

			const allOutput = written.join('')
			expect(allOutput).toContain('[o] Open')
			expect(allOutput).toContain('[c] Copy URL')
			expect(allOutput).toContain('[q] Quit')
			expect(allOutput).toContain('[r] Restart')

			tui.cleanup()
		})
	})

	describe('handleKeypress', () => {
		/**
		 * Simulate a keypress by finding the data handler registered on stdin
		 * and calling it with the given key.
		 */
		function pressKey(stdin: NodeJS.ReadStream, key: string) {
			const onCall = vi.mocked(stdin.on).mock.calls.find(
				([event]) => event === 'data'
			)
			if (onCall) {
				const handler = onCall[1] as (data: Buffer) => void
				handler(Buffer.from(key))
			}
		}

		it('should call openBrowser when "o" is pressed', () => {
			vi.mocked(openBrowser).mockResolvedValue(undefined)

			const { tui, stdin } = createTUI()
			tui.start()

			pressKey(stdin, 'o')

			expect(openBrowser).toHaveBeenCalledWith('http://localhost:3920')

			tui.cleanup()
		})

		it('should call onQuit when "q" is pressed', () => {
			const onQuit = vi.fn()
			const { tui, stdin } = createTUI({ onQuit })
			tui.start()

			pressKey(stdin, 'q')

			expect(onQuit).toHaveBeenCalled()

			tui.cleanup()
		})

		it('should call onQuit when Ctrl+C is pressed', () => {
			const onQuit = vi.fn()
			const { tui, stdin } = createTUI({ onQuit })
			tui.start()

			pressKey(stdin, '\x03')

			expect(onQuit).toHaveBeenCalled()

			tui.cleanup()
		})

		it('should call onRestart when "r" is pressed', () => {
			const onRestart = vi.fn()
			const { tui, stdin } = createTUI({ onRestart })
			tui.start()

			pressKey(stdin, 'r')

			expect(onRestart).toHaveBeenCalled()

			tui.cleanup()
		})

		it('should copy URL to clipboard when "c" is pressed', () => {
			vi.mocked(execa).mockResolvedValue({} as never)

			const originalPlatform = process.platform
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

			try {
				const { tui, stdin } = createTUI()
				tui.start()

				pressKey(stdin, 'c')

				// Should call pbcopy on darwin
				expect(execa).toHaveBeenCalledWith('pbcopy', [], { input: 'http://localhost:3920' })

				tui.cleanup()
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
			}
		})

		it('should ignore unknown keys', () => {
			const onQuit = vi.fn()
			const onRestart = vi.fn()
			const { tui, stdin } = createTUI({ onQuit, onRestart })
			tui.start()

			pressKey(stdin, 'x')

			expect(onQuit).not.toHaveBeenCalled()
			expect(onRestart).not.toHaveBeenCalled()

			tui.cleanup()
		})
	})

	describe('cleanup', () => {
		it('should restore scroll region to full terminal', () => {
			const { tui, written } = createTUI()
			tui.start()

			const preCleanupWrites = written.length

			tui.cleanup()

			const cleanupOutput = written.slice(preCleanupWrites).join('')
			// Reset scroll region: ESC[r
			expect(cleanupOutput).toContain('\x1b[r')
			// Show cursor
			expect(cleanupOutput).toContain('\x1b[?25h')
		})

		it('should disable raw mode', () => {
			const { tui, stdin } = createTUI()
			tui.start()

			tui.cleanup()

			expect(stdin.setRawMode).toHaveBeenCalledWith(false)
			expect(stdin.pause).toHaveBeenCalled()
		})

		it('should call restoreTerminalState', () => {
			const { tui } = createTUI()
			tui.start()
			tui.cleanup()

			expect(restoreTerminalState).toHaveBeenCalled()
		})

		it('should remove event listeners', () => {
			const { tui, stdin, stdout } = createTUI()
			tui.start()
			tui.cleanup()

			expect(stdin.removeListener).toHaveBeenCalledWith('data', expect.any(Function))
			expect(stdout.removeListener).toHaveBeenCalledWith('resize', expect.any(Function))
		})

		it('should be idempotent - calling cleanup twice does not error', () => {
			const { tui } = createTUI()
			tui.start()
			tui.cleanup()
			tui.cleanup() // second call should be safe
		})
	})

	describe('non-TTY behavior', () => {
		it('should not set raw mode when stdin is not a TTY', () => {
			const stdin = createMockStdin()
			Object.defineProperty(stdin, 'isTTY', { value: false, configurable: true })

			const { tui } = createTUI({ stdin })
			tui.start()

			expect(stdin.setRawMode).not.toHaveBeenCalled()

			tui.cleanup()
		})
	})
})
