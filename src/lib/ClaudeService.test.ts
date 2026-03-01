import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClaudeService, ClaudeWorkflowOptions } from './ClaudeService.js'
import { PromptTemplateManager } from './PromptTemplateManager.js'
import { SettingsManager, IloomSettings } from './SettingsManager.js'
import * as claudeUtils from '../utils/claude.js'
import { logger } from '../utils/logger.js'

vi.mock('../utils/claude.js')
vi.mock('../utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))
vi.mock('./SettingsManager.js', () => {
	return {
		SettingsManager: class MockSettingsManager {
			async loadSettings() {
				return {}
			}
		},
	}
})

describe('ClaudeService', () => {
	let service: ClaudeService
	let mockTemplateManager: PromptTemplateManager

	beforeEach(() => {
		mockTemplateManager = {
			getPrompt: vi.fn(),
		} as unknown as PromptTemplateManager

		service = new ClaudeService(mockTemplateManager)
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('isAvailable', () => {
		it('should return true when Claude CLI is available', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(true)

			const result = await service.isAvailable()

			expect(result).toBe(true)
			expect(claudeUtils.detectClaudeCli).toHaveBeenCalled()
		})

		it('should return false when Claude CLI is not available', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValueOnce(false)

			const result = await service.isAvailable()

			expect(result).toBe(false)
		})
	})

	describe('launchForWorkflow', () => {
		let originalIloomVscode: string | undefined

		beforeEach(() => {
			originalIloomVscode = process.env.ILOOM_VSCODE
			delete process.env.ILOOM_VSCODE
		})

		afterEach(() => {
			if (originalIloomVscode === undefined) {
				delete process.env.ILOOM_VSCODE
			} else {
				process.env.ILOOM_VSCODE = originalIloomVscode
			}
		})

		describe('issue workflow', () => {
			it('should launch Claude with acceptEdits permission mode (no model specified)', async () => {
				// Create a service with a mocked SettingsManager to avoid loading real settings.json
				const mockSettingsManager = {
					loadSettings: vi.fn().mockResolvedValue({} as IloomSettings),
				} as unknown as SettingsManager
				const serviceWithMockedSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

				const options: ClaudeWorkflowOptions = {
					type: 'issue',
					issueNumber: 123,
					title: 'Add authentication',
					workspacePath: '/workspace/issue-123',
					port: 3123,
					headless: false,
				}

				const prompt = 'Issue prompt with substitutions'
				vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
				// Non-headless mode calls launchClaudeInNewTerminalWindow
				vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

				await serviceWithMockedSettings.launchForWorkflow(options)

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith('issue', {
					ISSUE_NUMBER: 123,
					ISSUE_TITLE: 'Add authentication',
					WORKSPACE_PATH: '/workspace/issue-123',
					PORT: 3123,
					IS_VSCODE_MODE: false,
				})

				expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(prompt, {
					permissionMode: 'acceptEdits', // Default fallback when no settings configured
					workspacePath: '/workspace/issue-123',
					addDir: '/workspace/issue-123',
					headless: false,
					oneShot: 'default',
					port: 3123,
				})
			})

			it('should work without title', async () => {
				const options: ClaudeWorkflowOptions = {
					type: 'issue',
					issueNumber: 123,
					workspacePath: '/workspace',
					port: 3123,
				}

				const prompt = 'Issue prompt'
				vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
				vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

				await service.launchForWorkflow(options)

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith('issue', {
					ISSUE_NUMBER: 123,
					WORKSPACE_PATH: '/workspace',
					PORT: 3123,
					IS_VSCODE_MODE: false,
				})
			})

			it('should work without port', async () => {
				const options: ClaudeWorkflowOptions = {
					type: 'issue',
					issueNumber: 123,
					workspacePath: '/workspace',
				}

				const prompt = 'Issue prompt'
				vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
				vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

				await service.launchForWorkflow(options)

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith('issue', {
					ISSUE_NUMBER: 123,
					WORKSPACE_PATH: '/workspace',
					IS_VSCODE_MODE: false,
				})
			})
		})

		describe('pr workflow', () => {
			it('should launch Claude with acceptEdits permission mode', async () => {
				const options: ClaudeWorkflowOptions = {
					type: 'pr',
					prNumber: 456,
					title: 'Fix bug',
					workspacePath: '/workspace/pr-456',
					port: 3456,
					headless: false,
				}

				const prompt = 'PR prompt with substitutions'
				vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
				vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

				await service.launchForWorkflow(options)

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith('pr', {
					PR_NUMBER: 456,
					PR_TITLE: 'Fix bug',
					WORKSPACE_PATH: '/workspace/pr-456',
					PORT: 3456,
					IS_VSCODE_MODE: false,
				})

				// PR workflow uses acceptEdits permission mode by default
				expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(prompt, {
					permissionMode: 'acceptEdits',
					addDir: '/workspace/pr-456',
					workspacePath: '/workspace/pr-456',
					headless: false,
					oneShot: 'default',
					port: 3456,
				})
			})
		})

		describe('regular workflow', () => {
			it('should launch Claude with acceptEdits permission mode', async () => {
				const options: ClaudeWorkflowOptions = {
					type: 'regular',
					workspacePath: '/workspace/feature',
					headless: false,
				}

				const prompt = 'Regular prompt'
				vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
				vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

				await service.launchForWorkflow(options)

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith('regular', {
					WORKSPACE_PATH: '/workspace/feature',
					IS_VSCODE_MODE: false,
				})

				// Regular workflow uses acceptEdits permission mode by default
				expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(prompt, {
					permissionMode: 'acceptEdits',
					addDir: '/workspace/feature',
					workspacePath: '/workspace/feature',
					headless: false,
					oneShot: 'default',
				})
			})
		})

		describe('VS Code mode detection', () => {
			it('should pass IS_VSCODE_MODE: true when ILOOM_VSCODE=1', async () => {
				const originalEnv = process.env.ILOOM_VSCODE
				process.env.ILOOM_VSCODE = '1'

				try {
					const options: ClaudeWorkflowOptions = {
						type: 'issue',
						issueNumber: 123,
						workspacePath: '/workspace/issue-123',
					}

					const prompt = 'Issue prompt'
					vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
					vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

					await service.launchForWorkflow(options)

					expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
						'issue',
						expect.objectContaining({
							IS_VSCODE_MODE: true,
						})
					)
				} finally {
					if (originalEnv === undefined) {
						delete process.env.ILOOM_VSCODE
					} else {
						process.env.ILOOM_VSCODE = originalEnv
					}
				}
			})

			it('should pass IS_VSCODE_MODE: false when ILOOM_VSCODE is not set', async () => {
				const originalEnv = process.env.ILOOM_VSCODE
				delete process.env.ILOOM_VSCODE

				try {
					const options: ClaudeWorkflowOptions = {
						type: 'issue',
						issueNumber: 123,
						workspacePath: '/workspace/issue-123',
					}

					const prompt = 'Issue prompt'
					vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
					vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

					await service.launchForWorkflow(options)

					expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
						'issue',
						expect.objectContaining({
							IS_VSCODE_MODE: false,
						})
					)
				} finally {
					if (originalEnv !== undefined) {
						process.env.ILOOM_VSCODE = originalEnv
					}
				}
			})
		})

		describe('headless mode', () => {
			it('should launch in headless mode and return output', async () => {
				const options: ClaudeWorkflowOptions = {
					type: 'issue',
					issueNumber: 123,
					workspacePath: '/workspace',
					headless: true,
				}

				const prompt = 'Issue prompt'
				const output = 'Claude response'
				vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
				vi.mocked(claudeUtils.launchClaude).mockResolvedValueOnce(output)

				const result = await service.launchForWorkflow(options)

				expect(result).toBe(output)
				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					prompt,
					expect.objectContaining({
						headless: true,
					})
				)
			})
		})

		describe('error handling', () => {
			it('should propagate errors from template loading', async () => {
				const options: ClaudeWorkflowOptions = {
					type: 'issue',
					issueNumber: 123,
					workspacePath: '/workspace',
				}

				const error = new Error('Template not found')
				vi.mocked(mockTemplateManager.getPrompt).mockRejectedValueOnce(error)

				await expect(service.launchForWorkflow(options)).rejects.toThrow('Template not found')
			})

			it('should propagate errors from Claude launch in terminal window', async () => {
				const options: ClaudeWorkflowOptions = {
					type: 'issue',
					issueNumber: 123,
					workspacePath: '/workspace',
				}

				const prompt = 'Issue prompt'
				const error = new Error('Claude CLI error')
				vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
				// Non-headless mode calls launchClaudeInNewTerminalWindow
				vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockRejectedValueOnce(error)

				await expect(service.launchForWorkflow(options)).rejects.toThrow('Claude CLI error')
			})
		})
	})

	describe('getPermissionModeForWorkflow with settings', () => {
		it('should use configured permission mode for issue workflow when settings provided', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					workflows: {
						issue: {
							permissionMode: 'bypassPermissions',
						},
					},
				} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'issue',
				issueNumber: 123,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'Issue prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(
				prompt,
				expect.objectContaining({
					permissionMode: 'bypassPermissions',
				})
			)
		})

		it('should use configured permission mode for pr workflow when settings provided', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					workflows: {
						pr: {
							permissionMode: 'plan',
						},
					},
				} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'pr',
				prNumber: 456,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'PR prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(
				prompt,
				expect.objectContaining({
					permissionMode: 'plan',
				})
			)
		})

		it('should use configured permission mode for regular workflow when settings provided', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					workflows: {
						regular: {
							permissionMode: 'acceptEdits',
						},
					},
				} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'regular',
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'Regular prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(
				prompt,
				expect.objectContaining({
					permissionMode: 'acceptEdits',
				})
			)
		})

		it('should fall back to acceptEdits for issue workflow when no settings', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'issue',
				issueNumber: 123,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'Issue prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(
				prompt,
				expect.objectContaining({
					permissionMode: 'acceptEdits',
				})
			)
		})

		it('should fall back to acceptEdits for pr workflow when no settings', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'pr',
				prNumber: 456,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'PR prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(
				prompt,
				expect.objectContaining({
					permissionMode: 'acceptEdits',
				})
			)
		})

		it('should fall back to acceptEdits when workflows section missing', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					mainBranch: 'main',
				} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'pr',
				prNumber: 456,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'PR prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(
				prompt,
				expect.objectContaining({
					permissionMode: 'acceptEdits',
				})
			)
		})

		it('should fall back to acceptEdits when specific workflow type not configured', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					workflows: {
						issue: {
							permissionMode: 'bypassPermissions',
						},
					},
				} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'pr',
				prNumber: 456,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'PR prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(
				prompt,
				expect.objectContaining({
					permissionMode: 'acceptEdits',
				})
			)
		})

		it('should handle bypassPermissions mode from settings', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					workflows: {
						issue: {
							permissionMode: 'bypassPermissions',
						},
					},
				} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'issue',
				issueNumber: 123,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'Issue prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(claudeUtils.launchClaudeInNewTerminalWindow).toHaveBeenCalledWith(
				prompt,
				expect.objectContaining({
					permissionMode: 'bypassPermissions',
				})
			)
		})
	})

	describe('bypassPermissions warning', () => {
		it('should log warning when bypassPermissions mode is used for issue workflow', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					workflows: {
						issue: {
							permissionMode: 'bypassPermissions',
						},
					},
				} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'issue',
				issueNumber: 123,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'Issue prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('WARNING: Using bypassPermissions mode')
			)
		})

		it('should log warning when bypassPermissions mode is used for pr workflow', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					workflows: {
						pr: {
							permissionMode: 'bypassPermissions',
						},
					},
				} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'pr',
				prNumber: 456,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'PR prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('WARNING: Using bypassPermissions mode')
			)
		})

		it('should not log warning for acceptEdits mode', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					workflows: {
						issue: {
							permissionMode: 'acceptEdits',
						},
					},
				} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'issue',
				issueNumber: 123,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'Issue prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(logger.warn).not.toHaveBeenCalledWith(
				expect.stringContaining('WARNING: Using bypassPermissions mode')
			)
		})

		it('should not log warning for plan mode', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					workflows: {
						issue: {
							permissionMode: 'plan',
						},
					},
				} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'issue',
				issueNumber: 123,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'Issue prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(logger.warn).not.toHaveBeenCalledWith(
				expect.stringContaining('WARNING: Using bypassPermissions mode')
			)
		})

		it('should not log warning for default mode', async () => {
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({} as IloomSettings),
			} as unknown as SettingsManager

			const serviceWithSettings = new ClaudeService(mockTemplateManager, mockSettingsManager)

			const options: ClaudeWorkflowOptions = {
				type: 'pr',
				prNumber: 456,
				workspacePath: '/workspace',
				headless: false,
			}

			const prompt = 'PR prompt'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValueOnce(prompt)
			vi.mocked(claudeUtils.launchClaudeInNewTerminalWindow).mockResolvedValueOnce(undefined)

			await serviceWithSettings.launchForWorkflow(options)

			expect(logger.warn).not.toHaveBeenCalledWith(
				expect.stringContaining('WARNING: Using bypassPermissions mode')
			)
		})
	})

	describe('constructor', () => {
		it('should create default PromptTemplateManager if not provided', () => {
			const serviceWithDefaults = new ClaudeService()

			// Verify it was created by checking it doesn't throw
			expect(serviceWithDefaults).toBeDefined()
		})

		it('should use provided PromptTemplateManager', () => {
			const customManager = new PromptTemplateManager('custom/path')
			const serviceWithCustom = new ClaudeService(customManager)

			expect(serviceWithCustom).toBeDefined()
		})

		it('should accept SettingsManager as second parameter', () => {
			const customManager = new PromptTemplateManager('custom/path')
			// Use a mocked SettingsManager instead of a real one to avoid filesystem access
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({} as IloomSettings),
			} as unknown as SettingsManager
			const serviceWithBoth = new ClaudeService(customManager, mockSettingsManager)

			expect(serviceWithBoth).toBeDefined()
		})
	})
})
