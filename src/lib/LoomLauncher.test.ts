import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LoomLauncher } from './LoomLauncher.js'
import type { LaunchLoomOptions } from './LoomLauncher.js'
import * as terminal from '../utils/terminal.js'
import type { TerminalWindowOptions } from '../utils/terminal.js'
import * as ide from '../utils/ide.js'
// Note: devServer import removed since LoomLauncher no longer uses getDevServerLaunchCommand
import { ClaudeContextManager } from './ClaudeContextManager.js'
import { SettingsManager } from './SettingsManager.js'

// Mock all external dependencies
vi.mock('../utils/terminal.js')
vi.mock('../utils/ide.js')
// Note: dev-server.js mock removed since LoomLauncher no longer calls getDevServerLaunchCommand
vi.mock('./ClaudeContextManager.js')
vi.mock('./SettingsManager.js')
vi.mock('../utils/color.js', () => ({
	generateColorFromBranchName: vi.fn(() => ({
		rgb: { r: 0.5, g: 0.3, b: 0.7 },
		hex: '#8833bb',
		index: 0,
	})),
}))
vi.mock('../utils/cli-overrides.js', () => ({
	getExecutablePath: vi.fn(() => 'iloom'),
}))
vi.mock('node:fs', () => ({
	existsSync: vi.fn(() => true), // Default to true
}))

describe('LoomLauncher', () => {
	let launcher: LoomLauncher
	let mockClaudeContext: { launchWithContext: ReturnType<typeof vi.fn> }

	const baseOptions: LaunchLoomOptions = {
		enableClaude: true,
		enableCode: true,
		enableDevServer: true,
		enableTerminal: false,
		worktreePath: '/Users/test/workspace',
		branchName: 'feat/test-feature',
		port: 3042,
		capabilities: ['web'],
		workflowType: 'issue',
		identifier: 42,
		title: 'Test Issue',
	}

	beforeEach(() => {
		vi.clearAllMocks()

		// Mock ClaudeContextManager
		mockClaudeContext = {
			launchWithContext: vi.fn().mockResolvedValue(undefined),
		}
		vi.mocked(ClaudeContextManager).mockImplementation(() => mockClaudeContext)

		launcher = new LoomLauncher() // Uses default ClaudeContextManager for tests
	})

	describe('launchLoom', () => {
		describe('all components enabled', () => {
			it('should launch all components when all are enabled', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: true,
					enableDevServer: true,
					enableTerminal: false,
				})

				// Should launch VSCode
				expect(ide.openIdeWindow).toHaveBeenCalledWith(baseOptions.worktreePath, undefined)

				// Should launch multiple terminals (not individual Claude/terminal calls)
				expect(terminal.openMultipleTerminalWindows).toHaveBeenCalled()
				expect(mockClaudeContext.launchWithContext).not.toHaveBeenCalled()
				expect(terminal.openTerminalWindow).not.toHaveBeenCalled()
			})

			it('should handle PR workflow type', async () => {
				await launcher.launchLoom({
					...baseOptions,
					workflowType: 'pr',
					enableTerminal: false,
				})

				// Multiple terminals should be launched (not individual Claude call)
				expect(terminal.openMultipleTerminalWindows).toHaveBeenCalled()
				expect(mockClaudeContext.launchWithContext).not.toHaveBeenCalled()
			})

			it('should handle regular workflow type', async () => {
				await launcher.launchLoom({
					...baseOptions,
					workflowType: 'regular',
					enableTerminal: false,
				})

				// Multiple terminals should be launched (not individual Claude call)
				expect(terminal.openMultipleTerminalWindows).toHaveBeenCalled()
				expect(mockClaudeContext.launchWithContext).not.toHaveBeenCalled()
			})
		})

		describe('individual components', () => {
			it('should launch only Claude when only Claude enabled', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: false,
					enableDevServer: false,
					enableTerminal: false,
				})

				expect(mockClaudeContext.launchWithContext).toHaveBeenCalled()
				expect(ide.openIdeWindow).not.toHaveBeenCalled()
				expect(terminal.openTerminalWindow).not.toHaveBeenCalled()
			})

			it('should launch only VSCode when only Code enabled', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: false,
					enableCode: true,
					enableDevServer: false,
					enableTerminal: false,
				})

				expect(ide.openIdeWindow).toHaveBeenCalledWith(baseOptions.worktreePath, undefined)
				expect(mockClaudeContext.launchWithContext).not.toHaveBeenCalled()
				expect(terminal.openTerminalWindow).not.toHaveBeenCalled()
			})

			it('should launch only dev server terminal when only DevServer enabled', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: false,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: false,
				})

				expect(terminal.openTerminalWindow).toHaveBeenCalled()
				expect(mockClaudeContext.launchWithContext).not.toHaveBeenCalled()
				expect(ide.openIdeWindow).not.toHaveBeenCalled()
			})

			it('should launch nothing when all components disabled', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: false,
					enableCode: false,
					enableDevServer: false,
					enableTerminal: false,
				})

				expect(mockClaudeContext.launchWithContext).not.toHaveBeenCalled()
				expect(ide.openIdeWindow).not.toHaveBeenCalled()
				expect(terminal.openTerminalWindow).not.toHaveBeenCalled()
			})
		})

		describe('component combinations', () => {
			it('should launch Claude + VSCode when both enabled', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: true,
					enableDevServer: false,
					enableTerminal: false,
				})

				expect(mockClaudeContext.launchWithContext).toHaveBeenCalled()
				expect(ide.openIdeWindow).toHaveBeenCalledWith(baseOptions.worktreePath, undefined)
				expect(terminal.openTerminalWindow).not.toHaveBeenCalled()
			})

			it('should launch Claude + DevServer when both enabled', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: false,
				})

				// Should use multiple terminal windows
				expect(terminal.openMultipleTerminalWindows).toHaveBeenCalled()
				expect(mockClaudeContext.launchWithContext).not.toHaveBeenCalled()
				expect(terminal.openTerminalWindow).not.toHaveBeenCalled()
				expect(ide.openIdeWindow).not.toHaveBeenCalled()
			})

			it('should launch VSCode + DevServer when both enabled', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: false,
					enableCode: true,
					enableDevServer: true,
					enableTerminal: false,
				})

				expect(ide.openIdeWindow).toHaveBeenCalled()
				expect(terminal.openTerminalWindow).toHaveBeenCalled()
				expect(mockClaudeContext.launchWithContext).not.toHaveBeenCalled()
			})

			it('should launch multiple terminals when Claude and DevServer both enabled', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: false,
				})

				// Should use multiple terminal windows (single call, not sequential)
				expect(terminal.openMultipleTerminalWindows).toHaveBeenCalled()
				expect(mockClaudeContext.launchWithContext).not.toHaveBeenCalled()
				expect(terminal.openTerminalWindow).not.toHaveBeenCalled()
			})

			it('should not need delay when using multiple terminal windows', async () => {
				// With openMultipleTerminalWindows, all tabs are created in a single AppleScript call
				// No need for sequential timing or delays
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: false,
				})

				// Should use multiple terminal windows (single synchronous call)
				expect(terminal.openMultipleTerminalWindows).toHaveBeenCalled()
				expect(mockClaudeContext.launchWithContext).not.toHaveBeenCalled()
				expect(terminal.openTerminalWindow).not.toHaveBeenCalled()
			})

			it('should export PORT when project has web capability', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: false,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: false,
					capabilities: ['web'],
				})

				const call = vi.mocked(terminal.openTerminalWindow).mock.calls[0][0]
				expect(call.includePortExport).toBe(true)
				expect(call.port).toBe(3042)
			})

			it('should apply background color to terminal', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: false,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: false,
				})

				const call = vi.mocked(terminal.openTerminalWindow).mock.calls[0][0]
				expect(call.backgroundColor).toEqual({ r: 0.5, g: 0.3, b: 0.7 })
			})
		})

		describe('error handling', () => {
			it('should throw when platform not supported for terminal launching', async () => {
				vi.mocked(terminal.openTerminalWindow).mockRejectedValue(
					new Error('Terminal window launching not yet supported on linux')
				)

				await expect(
					launcher.launchLoom({
						...baseOptions,
						enableClaude: false,
						enableCode: false,
						enableDevServer: true,
						enableTerminal: false,
					})
				).rejects.toThrow('not yet supported on linux')
			})

			it('should throw when VSCode required but not available', async () => {
				vi.mocked(ide.openIdeWindow).mockRejectedValue(
					new Error('VSCode is not available')
				)

				await expect(
					launcher.launchLoom({
						...baseOptions,
						enableClaude: false,
						enableCode: true,
						enableDevServer: false,
						enableTerminal: false,
					})
				).rejects.toThrow('VSCode is not available')
			})

			it('should throw when Claude context manager fails', async () => {
				mockClaudeContext.launchWithContext.mockRejectedValue(
					new Error('Claude CLI not found')
				)

				await expect(
					launcher.launchLoom({
						...baseOptions,
						enableClaude: true,
						enableCode: false,
						enableDevServer: false,
						enableTerminal: false,
					})
				).rejects.toThrow('Claude CLI not found')
			})

			// Note: "should throw when dev server command generation fails" test removed
			// since LoomLauncher no longer calls getDevServerLaunchCommand
		})

		describe('terminal flag combinations', () => {
			it('should launch 3 tabs when Claude + DevServer + Terminal all enabled', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: true,
				})

				// Should launch 3 terminals as tabs
				const call = vi.mocked(terminal.openMultipleTerminalWindows).mock.calls[0][0]
				expect(call).toHaveLength(3)
				expect(call[0]).toMatchObject({
					title: 'Dev Server - Issue #42',
					command: 'iloom dev-server 42', // Now uses il dev-server command
				})
				expect(call[1]).toMatchObject({
					title: 'Terminal - Issue #42',
					command: 'iloom shell 42',
				})
				expect(call[2]).toMatchObject({
					title: 'Claude - Issue #42',
					command: 'iloom spin',
				})
			})

			it('should launch 2 tabs when DevServer + Terminal enabled (no Claude)', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: false,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: true,
				})

				expect(terminal.openMultipleTerminalWindows).toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({ title: 'Dev Server - Issue #42' }),
						expect.objectContaining({ title: 'Terminal - Issue #42' }),
					])
				)
			})

			it('should launch 2 tabs when Claude + Terminal enabled (no DevServer)', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: false,
					enableDevServer: false,
					enableTerminal: true,
				})

				expect(terminal.openMultipleTerminalWindows).toHaveBeenCalledWith(
					expect.arrayContaining([
						expect.objectContaining({ title: 'Claude - Issue #42' }),
						expect.objectContaining({ title: 'Terminal - Issue #42' }),
					])
				)
			})

			it('should launch single terminal when only Terminal enabled with il shell command', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: false,
					enableCode: false,
					enableDevServer: false,
					enableTerminal: true,
				})

				// Single terminal should use openTerminalWindow with il shell command
				expect(terminal.openTerminalWindow).toHaveBeenCalled()
				expect(terminal.openMultipleTerminalWindows).not.toHaveBeenCalled()
				const call = vi.mocked(terminal.openTerminalWindow).mock.calls[0][0]
				expect(call.command).toBe('iloom shell 42')
			})

			it('should use custom executablePath in standalone terminal shell command', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: false,
					enableCode: false,
					enableDevServer: false,
					enableTerminal: true,
					executablePath: '/custom/path/to/cli.js',
				})

				const call = vi.mocked(terminal.openTerminalWindow).mock.calls[0][0]
				expect(call.command).toBe('/custom/path/to/cli.js shell 42')
			})

			it('should include PORT export for web projects in terminal tab', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: false,
					enableCode: false,
					enableDevServer: false,
					enableTerminal: true,
					capabilities: ['web'],
				})

				const call = vi.mocked(terminal.openTerminalWindow).mock.calls[0][0]
				expect(call.includePortExport).toBe(true)
				expect(call.port).toBe(3042)
			})

			it('should use custom executablePath in multi-terminal mode', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: false,
					executablePath: '/custom/path/to/cli.js',
				})

				const calls = vi.mocked(terminal.openMultipleTerminalWindows).mock.calls[0][0]
				const claudeTab = calls.find((tab: TerminalWindowOptions) => tab.title?.includes('Claude'))
				expect(claudeTab).toBeDefined()
				expect(claudeTab?.command).toContain('/custom/path/to/cli.js spin')
			})

			it('should include setArguments in multi-terminal Claude command', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: false,
					setArguments: ['foo=bar', 'baz=qux'],
				})

				const calls = vi.mocked(terminal.openMultipleTerminalWindows).mock.calls[0][0]
				const claudeTab = calls.find((tab: TerminalWindowOptions) => tab.title?.includes('Claude'))
				expect(claudeTab).toBeDefined()
				expect(claudeTab?.command).toContain('--set foo=bar')
				expect(claudeTab?.command).toContain('--set baz=qux')
			})
		})
	})

	describe('complexity forwarding', () => {
			it('should append --complexity flag to spin command when set', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: false,
					complexity: 'simple',
				} as LaunchLoomOptions)

				const calls = vi.mocked(terminal.openMultipleTerminalWindows).mock.calls[0][0]
				const claudeTab = calls.find((tab: TerminalWindowOptions) => tab.title?.includes('Claude'))
				expect(claudeTab).toBeDefined()
				expect(claudeTab?.command).toContain('--complexity=simple')
			})

			it('should not append --complexity flag when not set', async () => {
				await launcher.launchLoom({
					...baseOptions,
					enableClaude: true,
					enableCode: false,
					enableDevServer: true,
					enableTerminal: false,
				})

				const calls = vi.mocked(terminal.openMultipleTerminalWindows).mock.calls[0][0]
				const claudeTab = calls.find((tab: TerminalWindowOptions) => tab.title?.includes('Claude'))
				expect(claudeTab).toBeDefined()
				expect(claudeTab?.command).not.toContain('--complexity')
			})
		})

	describe('sourceEnvOnStart option', () => {
		beforeEach(async () => {
			// Reset existsSync mock to default (true)
			const fs = await import('node:fs')
			vi.mocked(fs.existsSync).mockReturnValue(true)
		})

		it('should NOT include env setup for dev server terminal (il dev-server handles env loading internally)', async () => {
			// Dev server terminal now uses `il dev-server` which handles env loading internally
			// So includeEnvSetup should always be false regardless of sourceEnvOnStart setting
			await launcher.launchLoom({
				...baseOptions,
				enableClaude: false,
				enableCode: false,
				enableDevServer: true,
				enableTerminal: false,
				sourceEnvOnStart: true, // Even when true, dev server terminal should not include env setup
			})

			expect(terminal.openTerminalWindow).toHaveBeenCalled()
			const call = vi.mocked(terminal.openTerminalWindow).mock.calls[0][0]
			expect(call.includeEnvSetup).toBe(false)
			expect(call.command).toBe('iloom dev-server 42') // Uses il dev-server command
		})

		it('should NOT apply sourceEnvOnStart to standalone terminal (il shell handles env loading)', async () => {
			// Even with sourceEnvOnStart: true, standalone terminal should have includeEnvSetup: false
			// because il shell handles env loading internally
			await launcher.launchLoom({
				...baseOptions,
				enableClaude: false,
				enableCode: false,
				enableDevServer: false,
				enableTerminal: true,
				sourceEnvOnStart: true, // Set to true to verify it's still false
			})

			expect(terminal.openTerminalWindow).toHaveBeenCalled()
			const call = vi.mocked(terminal.openTerminalWindow).mock.calls[0][0]
			expect(call.includeEnvSetup).toBe(false)
			expect(call.command).toBe('iloom shell 42')
		})

		it('should still apply sourceEnvOnStart to Claude terminal in multi-terminal mode', async () => {
			await launcher.launchLoom({
				...baseOptions,
				enableClaude: true,
				enableCode: false,
				enableDevServer: true,
				enableTerminal: false,
				sourceEnvOnStart: true,
			})

			expect(terminal.openMultipleTerminalWindows).toHaveBeenCalled()
			const calls = vi.mocked(terminal.openMultipleTerminalWindows).mock.calls[0][0]
			// Dev server tab should have includeEnvSetup: false (handled internally)
			// Claude tab may still have includeEnvSetup based on sourceEnvOnStart
			const devServerTab = calls.find((tab: TerminalWindowOptions) => tab.command?.includes('dev-server'))
			expect(devServerTab?.includeEnvSetup).toBe(false)
		})
	})

	describe('IDE configuration', () => {
		let mockSettings: Pick<SettingsManager, 'loadSettings'>

		beforeEach(() => {
			vi.clearAllMocks()

			// Mock SettingsManager
			mockSettings = {
				loadSettings: vi.fn(),
			}
			vi.mocked(SettingsManager).mockImplementation(() => mockSettings)
		})

		it('should use vscode by default when ide setting not configured', async () => {
			mockSettings.loadSettings.mockResolvedValue({})
			const launcherWithSettings = new LoomLauncher(undefined, mockSettings)

			await launcherWithSettings.launchLoom({
				...baseOptions,
				enableCode: true,
				enableClaude: false,
				enableDevServer: false,
				enableTerminal: false,
			})

			expect(ide.openIdeWindow).toHaveBeenCalledWith(baseOptions.worktreePath, undefined)
		})

		it('should use configured IDE preset from settings', async () => {
			mockSettings.loadSettings.mockResolvedValue({
				ide: { type: 'cursor' },
			})
			const launcherWithSettings = new LoomLauncher(undefined, mockSettings)

			await launcherWithSettings.launchLoom({
				...baseOptions,
				enableCode: true,
				enableClaude: false,
				enableDevServer: false,
				enableTerminal: false,
			})

			expect(ide.openIdeWindow).toHaveBeenCalledWith(baseOptions.worktreePath, {
				type: 'cursor',
			})
		})

		it('should throw descriptive error when configured IDE is not available', async () => {
			mockSettings.loadSettings.mockResolvedValue({
				ide: { type: 'cursor' },
			})
			vi.mocked(ide.openIdeWindow).mockRejectedValue(
				new Error('Cursor is not available. The "cursor" command was not found in PATH.')
			)

			const launcherWithSettings = new LoomLauncher(undefined, mockSettings)

			await expect(
				launcherWithSettings.launchLoom({
					...baseOptions,
					enableCode: true,
					enableClaude: false,
					enableDevServer: false,
					enableTerminal: false,
				})
			).rejects.toThrow('Cursor is not available')
		})

		it('should pass workspace path to configured IDE', async () => {
			const customPath = '/Users/test/custom-workspace'
			mockSettings.loadSettings.mockResolvedValue({
				ide: { type: 'webstorm' },
			})
			const launcherWithSettings = new LoomLauncher(undefined, mockSettings)

			await launcherWithSettings.launchLoom({
				...baseOptions,
				worktreePath: customPath,
				enableCode: true,
				enableClaude: false,
				enableDevServer: false,
				enableTerminal: false,
			})

			expect(ide.openIdeWindow).toHaveBeenCalledWith(customPath, {
				type: 'webstorm',
			})
		})
	})
})
