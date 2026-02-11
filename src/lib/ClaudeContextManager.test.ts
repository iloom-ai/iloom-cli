import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClaudeContextManager, ClaudeContext } from './ClaudeContextManager.js'
import { ClaudeService } from './ClaudeService.js'
import { PromptTemplateManager } from './PromptTemplateManager.js'

vi.mock('../utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

describe('ClaudeContextManager', () => {
	let manager: ClaudeContextManager
	let mockClaudeService: ClaudeService
	let mockTemplateManager: PromptTemplateManager

	beforeEach(() => {
		mockClaudeService = {
			launchForWorkflow: vi.fn(),
			isAvailable: vi.fn(),
			generateBranchNameWithFallback: vi.fn(),
		} as unknown as ClaudeService

		mockTemplateManager = {
			getPrompt: vi.fn(),
			loadTemplate: vi.fn(),
			substituteVariables: vi.fn(),
		} as unknown as PromptTemplateManager

		manager = new ClaudeContextManager(mockClaudeService, mockTemplateManager)
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('prepareContext', () => {
		it('should validate and accept valid issue context', async () => {
			const context: ClaudeContext = {
				type: 'issue',
				identifier: 123,
				title: 'Add authentication',
				workspacePath: '/workspace/issue-123',
				port: 3123,
			}

			await expect(manager.prepareContext(context)).resolves.toBeUndefined()
		})

		it('should validate and accept valid PR context', async () => {
			const context: ClaudeContext = {
				type: 'pr',
				identifier: 456,
				title: 'Fix bug',
				workspacePath: '/workspace/pr-456',
				port: 3456,
			}

			await expect(manager.prepareContext(context)).resolves.toBeUndefined()
		})

		it('should validate and accept valid regular context', async () => {
			const context: ClaudeContext = {
				type: 'regular',
				identifier: 'feature-branch',
				workspacePath: '/workspace/feature',
				port: 3000,
			}

			await expect(manager.prepareContext(context)).resolves.toBeUndefined()
		})

		it('should throw error when workspace path is missing', async () => {
			const context = {
				type: 'issue',
				identifier: 123,
				port: 3123,
			} as ClaudeContext

			await expect(manager.prepareContext(context)).rejects.toThrow(
				'Workspace path is required'
			)
		})

		it('should throw error when issue identifier is undefined', async () => {
			const context = {
				type: 'issue',
				identifier: undefined,
				workspacePath: '/workspace',
				port: 3000,
			} as unknown as ClaudeContext

			await expect(manager.prepareContext(context)).rejects.toThrow(
				'Issue identifier is required'
			)
		})

		it('should throw error when PR identifier is undefined', async () => {
			const context = {
				type: 'pr',
				identifier: undefined,
				workspacePath: '/workspace',
				port: 3000,
			} as unknown as ClaudeContext

			await expect(manager.prepareContext(context)).rejects.toThrow(
				'PR identifier is required'
			)
		})

		it('should accept string identifier for regular type', async () => {
			const context: ClaudeContext = {
				type: 'regular',
				identifier: 'feature-branch',
				workspacePath: '/workspace',
				port: 3000,
			}

			await expect(manager.prepareContext(context)).resolves.toBeUndefined()
		})
	})

	describe('launchWithContext', () => {
		it('should launch Claude for issue workflow', async () => {
			const context: ClaudeContext = {
				type: 'issue',
				identifier: 123,
				title: 'Add authentication',
				workspacePath: '/workspace/issue-123',
				port: 3123,
			}

			vi.mocked(mockClaudeService.launchForWorkflow).mockResolvedValueOnce(undefined)

			await manager.launchWithContext(context, false)

			expect(mockClaudeService.launchForWorkflow).toHaveBeenCalledWith({
				type: 'issue',
				issueNumber: 123,
				title: 'Add authentication',
				workspacePath: '/workspace/issue-123',
				port: 3123,
				headless: false,
				oneShot: 'default',
			})
		})

		it('should launch Claude for PR workflow', async () => {
			const context: ClaudeContext = {
				type: 'pr',
				identifier: 456,
				title: 'Fix bug',
				workspacePath: '/workspace/pr-456',
				port: 3456,
			}

			vi.mocked(mockClaudeService.launchForWorkflow).mockResolvedValueOnce(undefined)

			await manager.launchWithContext(context, false)

			expect(mockClaudeService.launchForWorkflow).toHaveBeenCalledWith({
				type: 'pr',
				prNumber: 456,
				title: 'Fix bug',
				workspacePath: '/workspace/pr-456',
				port: 3456,
				headless: false,
				oneShot: 'default',
			})
		})

		it('should launch Claude for regular workflow', async () => {
			const context: ClaudeContext = {
				type: 'regular',
				identifier: 'feature-branch',
				workspacePath: '/workspace/feature',
				port: 3000,
			}

			vi.mocked(mockClaudeService.launchForWorkflow).mockResolvedValueOnce(undefined)

			await manager.launchWithContext(context, false)

			expect(mockClaudeService.launchForWorkflow).toHaveBeenCalledWith({
				type: 'regular',
				title: undefined,
				workspacePath: '/workspace/feature',
				port: 3000,
				headless: false,
				oneShot: 'default',
			})
		})

		it('should launch in headless mode when specified', async () => {
			const context: ClaudeContext = {
				type: 'issue',
				identifier: 123,
				workspacePath: '/workspace',
				port: 3123,
			}

			const output = 'Claude output'
			vi.mocked(mockClaudeService.launchForWorkflow).mockResolvedValueOnce(output)

			const result = await manager.launchWithContext(context, true)

			expect(result).toBe(output)
			expect(mockClaudeService.launchForWorkflow).toHaveBeenCalledWith(
				expect.objectContaining({
					headless: true,
				})
			)
		})

		it('should default to interactive mode', async () => {
			const context: ClaudeContext = {
				type: 'issue',
				identifier: 123,
				workspacePath: '/workspace',
				port: 3123,
			}

			vi.mocked(mockClaudeService.launchForWorkflow).mockResolvedValueOnce(undefined)

			await manager.launchWithContext(context)

			expect(mockClaudeService.launchForWorkflow).toHaveBeenCalledWith(
				expect.objectContaining({
					headless: false,
				})
			)
		})

		it('should validate context before launching', async () => {
			const context = {
				type: 'issue',
				identifier: 123,
				// Missing workspacePath
				port: 3123,
			} as ClaudeContext

			await expect(manager.launchWithContext(context)).rejects.toThrow(
				'Workspace path is required'
			)

			expect(mockClaudeService.launchForWorkflow).not.toHaveBeenCalled()
		})

		it('should propagate errors from Claude service', async () => {
			const context: ClaudeContext = {
				type: 'issue',
				identifier: 123,
				workspacePath: '/workspace',
				port: 3123,
			}

			const error = new Error('Claude launch failed')
			vi.mocked(mockClaudeService.launchForWorkflow).mockRejectedValueOnce(error)

			await expect(manager.launchWithContext(context)).rejects.toThrow('Claude launch failed')
		})

		it('should not include undefined title in workflow options', async () => {
			const context: ClaudeContext = {
				type: 'issue',
				identifier: 123,
				// No title provided
				workspacePath: '/workspace',
				port: 3123,
			}

			vi.mocked(mockClaudeService.launchForWorkflow).mockResolvedValueOnce(undefined)

			await manager.launchWithContext(context)

			expect(mockClaudeService.launchForWorkflow).toHaveBeenCalledWith({
				type: 'issue',
				issueNumber: 123,
				title: undefined,
				workspacePath: '/workspace',
				port: 3123,
				headless: false,
				oneShot: 'default',
			})
		})
	})

	describe('constructor', () => {
		it('should create with default services when not provided', () => {
			const managerWithDefaults = new ClaudeContextManager()

			expect(managerWithDefaults).toBeDefined()
		})

		it('should use provided services', () => {
			const customService = new ClaudeService()
			const customTemplateManager = new PromptTemplateManager()
			const managerWithCustom = new ClaudeContextManager(customService, customTemplateManager)

			expect(managerWithCustom).toBeDefined()
		})
	})
})
