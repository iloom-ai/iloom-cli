import { execa } from 'execa'
import { generateColorFromBranchName } from '../utils/color.js'
import { logger } from '../utils/logger.js'
import { isWSL } from '../utils/platform-detect.js'

/**
 * Platform type for color application
 */
type Platform = 'darwin' | 'linux' | 'win32' | 'unsupported'

/**
 * Manages terminal background color application based on branch names
 * Provides cross-platform support with graceful degradation
 */
export class TerminalColorManager {
	/**
	 * Apply terminal background color based on branch name
	 *
	 * @param branchName - Branch name to generate color from
	 */
	async applyTerminalColor(branchName: string): Promise<void> {
		try {
			// Generate color from branch name
			const colorData = generateColorFromBranchName(branchName)

			// Apply color based on platform
			const platform = this.detectPlatform()

			switch (platform) {
				case 'darwin':
					await this.applyMacOSColor(colorData.rgb)
					break
				case 'linux':
					await this.applyLinuxColor(colorData.rgb)
					break
				case 'win32':
					await this.applyWindowsColor(colorData.rgb)
					break
				default:
					await this.applyUnsupportedPlatformColor()
			}
		} catch (error) {
			throw new Error(
				`Failed to apply terminal color: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
		}
	}

	/**
	 * Apply terminal color on macOS using AppleScript
	 */
	private async applyMacOSColor(rgb: { r: number; g: number; b: number }): Promise<void> {
		// Scale RGB values for Terminal.app (0-255 → 0-65535)
		const r = rgb.r * 256
		const g = rgb.g * 256
		const b = rgb.b * 256

		// AppleScript to set Terminal.app background color
		// Note: This sets the color for the current terminal tab
		const appleScript = `
      tell application "Terminal"
        set background color of selected tab of window 1 to {${r}, ${g}, ${b}}
      end tell
    `

		try {
			await execa('osascript', ['-e', appleScript])
			logger.debug(`Applied terminal background color: rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`)
		} catch (error) {
			throw new Error(
				`Failed to execute AppleScript for terminal coloring: ${
					error instanceof Error ? error.message : 'Unknown error'
				}`
			)
		}
	}

	/**
	 * Apply terminal color on Linux
	 * On WSL, tab colors are applied at launch time via Windows Terminal's --tabColor flag.
	 * On native Linux, terminal background colors have limited CLI support.
	 */
	private async applyLinuxColor(_rgb: { r: number; g: number; b: number }): Promise<void> {
		if (isWSL()) {
			logger.debug(
				'Windows Terminal tab colors are applied at launch time via --tabColor. ' +
					'VSCode title bar colors will still be applied.'
			)
		} else {
			logger.warn(
				'Terminal background colors have limited support on Linux. ' +
					'VSCode title bar colors will still be applied. ' +
					'Future versions may add support for specific terminal emulators.'
			)
		}
	}

	/**
	 * Apply terminal color on Windows
	 * Not supported yet - graceful degradation with warning
	 */
	private async applyWindowsColor(_rgb: { r: number; g: number; b: number }): Promise<void> {
		logger.warn(
			'Terminal background colors are not supported on Windows yet. ' +
				'VSCode title bar colors will still be applied. ' +
				'Future versions may add Windows Terminal support.'
		)
		// Future: Windows Terminal JSON config support
	}

	/**
	 * Handle unsupported platforms
	 */
	private async applyUnsupportedPlatformColor(): Promise<void> {
		logger.warn(
			`Terminal background colors are not supported on platform: ${process.platform}. ` +
				'VSCode title bar colors will still be applied.'
		)
	}

	/**
	 * Detect current platform
	 */
	private detectPlatform(): Platform {
		switch (process.platform) {
			case 'darwin':
				return 'darwin'
			case 'linux':
				return 'linux'
			case 'win32':
				return 'win32'
			default:
				return 'unsupported'
		}
	}
}
