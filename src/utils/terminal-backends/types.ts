import type { TerminalWindowOptions } from '../terminal.js'

/**
 * Backend interface for platform-specific terminal window launching.
 *
 * Each backend implements opening single and multiple terminal tabs/windows
 * using the platform's native terminal emulator (or tmux for headless).
 */
export interface TerminalBackend {
	readonly name: string
	openSingle(options: TerminalWindowOptions): Promise<void>
	openMultiple(optionsArray: TerminalWindowOptions[]): Promise<void>
}
