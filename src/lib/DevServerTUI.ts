import { execa } from 'execa'
import { openBrowser } from '../utils/browser.js'
import { restoreTerminalState } from '../utils/terminal.js'
import { logger } from '../utils/logger.js'

/**
 * ANSI escape sequences used for TUI rendering.
 */
const ESC = '\x1b'
const CSI = `${ESC}[`

/** Save cursor position */
const CURSOR_SAVE = `${ESC}7`
/** Restore cursor position */
const CURSOR_RESTORE = `${ESC}8`
/** Hide cursor */
const CURSOR_HIDE = `${CSI}?25l`
/** Show cursor */
const CURSOR_SHOW = `${CSI}?25h`
/** Clear from cursor to end of line */
const CLEAR_LINE = `${CSI}K`
/** Clear entire screen and reset cursor to top-left */
const CLEAR_SCREEN = `${CSI}2J${CSI}H`
/** Reset scroll region to full terminal */
const SCROLL_REGION_RESET = `${CSI}r`

/** Move cursor to row,col (1-based) */
function moveTo(row: number, col: number): string {
	return `${CSI}${row};${col}H`
}

/** Set scroll region to rows top..bottom (1-based, inclusive) */
function setScrollRegion(top: number, bottom: number): string {
	return `${CSI}${top};${bottom}r`
}

export type DevServerStatus = 'Running' | 'Stopped' | 'Restarting'

export interface DevServerTUIOptions {
	url: string
	port: number
	containerPort?: number | undefined
	stdout?: NodeJS.WriteStream | undefined
	stdin?: NodeJS.ReadStream | undefined
	onQuit?: (() => void) | undefined
	onRestart?: (() => void) | undefined
}

/**
 * Height of the status bar area (top border + content + bottom border + hint line).
 */
const STATUS_BAR_HEIGHT = 4

/**
 * DevServerTUI - Lightweight terminal UI for dev server.
 *
 * Uses ANSI escape sequences to set a scroll region that restricts output
 * to the upper portion of the terminal, keeping a fixed status bar at the
 * bottom showing the external URL, server status, and port mapping.
 *
 * Keyboard shortcuts:
 *   o - open URL in browser
 *   c - copy URL to clipboard
 *   q - quit (stop container and exit)
 *   r - restart (if callback provided)
 */
export class DevServerTUI {
	private readonly url: string
	private readonly port: number
	private readonly containerPort: number | undefined
	private readonly stdout: NodeJS.WriteStream
	private readonly stdin: NodeJS.ReadStream
	private readonly onQuit: (() => void) | undefined
	private readonly onRestart: (() => void) | undefined
	private status: DevServerStatus = 'Running'
	private started = false
	private cleanedUp = false
	private readonly onData: (data: Buffer) => void
	private readonly onResize: () => void
	private readonly onProcessExit: () => void

	constructor(options: DevServerTUIOptions) {
		this.url = options.url
		this.port = options.port
		this.containerPort = options.containerPort
		this.stdout = options.stdout ?? process.stdout
		this.stdin = options.stdin ?? process.stdin
		this.onQuit = options.onQuit
		this.onRestart = options.onRestart

		// Bind handlers so they can be removed later
		this.onData = (data: Buffer): void => this.handleKeypress(data)
		this.onResize = (): void => this.handleResize()
		this.onProcessExit = (): void => this.cleanup()
	}

	/**
	 * Start the TUI - sets up scroll region, renders status bar, starts keyboard listener.
	 */
	start(): void {
		if (this.started) return
		this.started = true

		const rows = this.stdout.rows ?? 24

		// Hide cursor during TUI operation
		this.stdout.write(CURSOR_HIDE)

		// Clear the screen so previous output (build logs, startup messages) doesn't
		// bleed through the scroll region and create a confusing mix of old and new text
		this.stdout.write(CLEAR_SCREEN)

		// Set scroll region: top of terminal to (total rows - status bar height)
		const scrollBottom = Math.max(1, rows - STATUS_BAR_HEIGHT)
		this.stdout.write(setScrollRegion(1, scrollBottom))

		// Move cursor to top-left of scroll region
		this.stdout.write(moveTo(1, 1))

		// Render status bar in the fixed area below scroll region
		this.renderStatusBar()

		// Start keyboard listener (raw mode)
		if (this.stdin.isTTY && typeof this.stdin.setRawMode === 'function') {
			this.stdin.setRawMode(true)
			this.stdin.resume()
			this.stdin.on('data', this.onData)
		}

		// Listen for terminal resize
		this.stdout.on('resize', this.onResize)

		// Ensure terminal state is restored on unexpected exit (uncaught exceptions, etc.)
		process.on('exit', this.onProcessExit)
	}

	/**
	 * Write server output into the scroll region.
	 * The scroll region constrains the cursor naturally, so output stays
	 * above the status bar without explicit cursor repositioning.
	 */
	handleOutput(data: Buffer | string): void {
		if (!this.started || this.cleanedUp) return

		this.stdout.write(data.toString())
	}

	/**
	 * Update the status displayed in the status bar.
	 */
	updateStatus(status: DevServerStatus): void {
		this.status = status
		if (this.started && !this.cleanedUp) {
			this.renderStatusBar()
		}
	}

	/**
	 * Render the status bar in the fixed area below the scroll region.
	 */
	private renderStatusBar(): void {
		const rows = this.stdout.rows ?? 24
		const cols = this.stdout.columns ?? 80

		// Guard: terminal too small for status bar
		if (rows < STATUS_BAR_HEIGHT + 2) return

		// Status bar starts at row (rows - STATUS_BAR_HEIGHT + 1)
		const barStartRow = rows - STATUS_BAR_HEIGHT + 1

		// Build content segments
		const urlSegment = ` ${this.url} `
		const statusIcon = this.status === 'Running' ? '\u25A0' : this.status === 'Stopped' ? '\u25A1' : '\u25C6'
		const statusSegment = ` ${statusIcon} ${this.status} `
		const portSegment = this.containerPort
			? ` Port ${this.containerPort} \u2192 ${this.port} `
			: ` Port ${this.port} `

		// Build content line with separators
		const contentParts = `\u2502${urlSegment}\u2502${statusSegment}\u2502${portSegment}\u2502`
		// Pad content to fill width
		const contentLine = contentParts.length < cols
			? contentParts + ' '.repeat(cols - contentParts.length)
			: contentParts.substring(0, cols)

		// Horizontal border line
		const innerWidth = Math.max(0, cols - 2)
		const topBorder = `\u250C${'\u2500'.repeat(innerWidth)}\u2510`
		const bottomBorder = `\u2514${'\u2500'.repeat(innerWidth)}\u2518`

		// Hint line showing keyboard shortcuts
		const hintLine = ' [o] Open  [c] Copy URL  [r] Restart  [q] Quit'
		const paddedHint = hintLine.length < cols
			? hintLine + ' '.repeat(cols - hintLine.length)
			: hintLine.substring(0, cols)

		// Save cursor, write status bar, restore cursor
		this.stdout.write(CURSOR_SAVE)

		// Row 1: top border
		this.stdout.write(moveTo(barStartRow, 1) + CLEAR_LINE + topBorder)
		// Row 2: content
		this.stdout.write(moveTo(barStartRow + 1, 1) + CLEAR_LINE + contentLine)
		// Row 3: bottom border
		this.stdout.write(moveTo(barStartRow + 2, 1) + CLEAR_LINE + bottomBorder)
		// Row 4: hint line
		this.stdout.write(moveTo(barStartRow + 3, 1) + CLEAR_LINE + paddedHint)

		this.stdout.write(CURSOR_RESTORE)
	}

	/**
	 * Handle keyboard input.
	 */
	private handleKeypress(data: Buffer): void {
		const key = data.toString('utf8')

		switch (key) {
			case 'o':
			case 'O':
				void openBrowser(this.url).catch((err: unknown) => {
					logger.warn(`Failed to open browser: ${err instanceof Error ? err.message : 'Unknown error'}`)
				})
				break

			case 'c':
			case 'C':
				void this.copyToClipboard(this.url).catch((err: unknown) => {
					logger.warn(`Failed to copy to clipboard: ${err instanceof Error ? err.message : 'Unknown error'}`)
				})
				break

			case 'q':
			case 'Q':
			case '\x03': // Ctrl+C
				if (this.onQuit) {
					this.onQuit()
				}
				break

			case 'r':
			case 'R':
				if (this.onRestart) {
					this.onRestart()
				}
				break
		}
	}

	/**
	 * Copy text to clipboard using platform-specific commands.
	 */
	private async copyToClipboard(text: string): Promise<void> {
		const platform = process.platform

		let command: string
		let args: string[]

		if (platform === 'darwin') {
			command = 'pbcopy'
			args = []
		} else if (platform === 'win32') {
			command = 'clip'
			args = []
		} else {
			// Linux
			command = 'xclip'
			args = ['-selection', 'clipboard']
		}

		await execa(command, args, { input: text })
	}

	/**
	 * Handle terminal resize - re-establish scroll region and re-render status bar.
	 */
	private handleResize(): void {
		if (!this.started || this.cleanedUp) return

		const rows = this.stdout.rows ?? 24

		// Guard: terminal too small for status bar
		if (rows < STATUS_BAR_HEIGHT + 2) return

		const scrollBottom = Math.max(1, rows - STATUS_BAR_HEIGHT)

		// Re-establish scroll region for new size
		this.stdout.write(setScrollRegion(1, scrollBottom))

		// Re-render status bar at new position
		this.renderStatusBar()

		// Move cursor back into scroll region
		this.stdout.write(moveTo(scrollBottom, 1))
	}

	/**
	 * Clean up: restore full scroll region, disable raw mode, restore terminal.
	 */
	cleanup(): void {
		if (this.cleanedUp) return
		this.cleanedUp = true

		// Remove event listeners
		if (this.stdin.isTTY && typeof this.stdin.setRawMode === 'function') {
			this.stdin.removeListener('data', this.onData)
			this.stdin.setRawMode(false)
			this.stdin.pause()
		}

		this.stdout.removeListener('resize', this.onResize)
		process.removeListener('exit', this.onProcessExit)

		// Reset scroll region to full terminal
		this.stdout.write(SCROLL_REGION_RESET)

		// Show cursor
		this.stdout.write(CURSOR_SHOW)

		// Move cursor to bottom of terminal
		const rows = this.stdout.rows ?? 24
		this.stdout.write(moveTo(rows, 1))
		this.stdout.write('\n')

		// Restore terminal state
		restoreTerminalState()
	}
}
