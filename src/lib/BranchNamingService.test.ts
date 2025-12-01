import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
	DefaultBranchNamingService,
	SimpleBranchNameStrategy,
	ClaudeBranchNameStrategy,
	type BranchNameStrategy,
} from './BranchNamingService.js'

// Hoist the mock factory to ensure it's available before module resolution
const mockGenerateBranchName = vi.fn()

vi.mock('../utils/claude.js', () => ({
	generateBranchName: mockGenerateBranchName,
}))

// Setup the mock return value
beforeEach(() => {
	mockGenerateBranchName.mockResolvedValue('feat/issue-123-ai-generated-branch')
})

describe('BranchNamingService', () => {
	describe('DefaultBranchNamingService', () => {
		describe('constructor and strategy initialization', () => {
			it('should use SimpleBranchNameStrategy when useClaude is false', () => {
				const service = new DefaultBranchNamingService({ useClaude: false })
				const strategy = service.getDefaultStrategy()
				expect(strategy).toBeInstanceOf(SimpleBranchNameStrategy)
			})

			it('should use ClaudeBranchNameStrategy when useClaude is true', () => {
				const service = new DefaultBranchNamingService({ useClaude: true })
				const strategy = service.getDefaultStrategy()
				expect(strategy).toBeInstanceOf(ClaudeBranchNameStrategy)
			})

			it('should use ClaudeBranchNameStrategy by default (when useClaude not specified)', () => {
				const service = new DefaultBranchNamingService()
				const strategy = service.getDefaultStrategy()
				expect(strategy).toBeInstanceOf(ClaudeBranchNameStrategy)
			})

			it('should use custom strategy when provided', () => {
				class CustomStrategy implements BranchNameStrategy {
					async generate(): Promise<string> {
						return 'custom/branch'
					}
				}
				const customStrategy = new CustomStrategy()
				const service = new DefaultBranchNamingService({ strategy: customStrategy })
				const strategy = service.getDefaultStrategy()
				expect(strategy).toBe(customStrategy)
			})
		})

		describe('generateBranchName', () => {
			it('should use default strategy when no override provided', async () => {
				const service = new DefaultBranchNamingService({ useClaude: false })
				const branchName = await service.generateBranchName({
					issueNumber: 123,
					title: 'Test Issue Title',
				})
				expect(branchName).toBe('feat/issue-123-test-issue-title')
			})

			it('should use override strategy when provided', async () => {
				class OverrideStrategy implements BranchNameStrategy {
					async generate(issueNumber: number): Promise<string> {
						return `override/issue-${issueNumber}`
					}
				}
				const service = new DefaultBranchNamingService({ useClaude: false })
				const branchName = await service.generateBranchName({
					issueNumber: 456,
					title: 'Test',
					strategy: new OverrideStrategy(),
				})
				expect(branchName).toBe('override/issue-456')
			})

			it('should delegate to strategy.generate with correct parameters', async () => {
				const mockStrategy: BranchNameStrategy = {
					generate: vi.fn().mockResolvedValue('mock/branch'),
				}
				const service = new DefaultBranchNamingService({ strategy: mockStrategy })
				await service.generateBranchName({
					issueNumber: 789,
					title: 'Some Title',
				})
				expect(mockStrategy.generate).toHaveBeenCalledWith(789, 'Some Title')
			})
		})

		describe('setDefaultStrategy and getDefaultStrategy', () => {
			it('should allow changing default strategy at runtime', () => {
				const service = new DefaultBranchNamingService({ useClaude: false })
				const newStrategy = new ClaudeBranchNameStrategy()
				service.setDefaultStrategy(newStrategy)
				expect(service.getDefaultStrategy()).toBe(newStrategy)
			})

			it('should use new default strategy for subsequent generations', async () => {
				const service = new DefaultBranchNamingService({ useClaude: false })
				// Initial strategy is SimpleBranchNameStrategy
				const firstBranch = await service.generateBranchName({
					issueNumber: 100,
					title: 'Test',
				})
				expect(firstBranch).toBe('feat/issue-100-test')

				// Change to Claude strategy
				service.setDefaultStrategy(new ClaudeBranchNameStrategy())
				const secondBranch = await service.generateBranchName({
					issueNumber: 200,
					title: 'Test',
				})
				// The mock always returns the same value, so this will be the mocked value
				expect(secondBranch).toBe('feat/issue-123-ai-generated-branch')
			})
		})
	})

	describe('SimpleBranchNameStrategy', () => {
		it('should generate branch name with feat prefix', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(123, 'Add new feature')
			expect(branchName).toBe('feat/issue-123-add-new-feature')
		})

		it('should convert title to lowercase', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(456, 'UPPERCASE TITLE')
			expect(branchName).toBe('feat/issue-456-uppercase-title')
		})

		it('should replace non-alphanumeric characters with hyphens', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(789, 'Fix bug #123 & issue')
			expect(branchName).toBe('feat/issue-789-fix-bug-123-issue')
		})

		it('should trim leading and trailing hyphens', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(111, '---start and end---')
			expect(branchName).toBe('feat/issue-111-start-and-end')
		})

		it('should truncate slug to 20 characters', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(
				222,
				'This is a very long title that should be truncated'
			)
			// The slug is truncated to 20 characters, which may end with a hyphen
			expect(branchName.startsWith('feat/issue-222-this-is-a-very-long')).toBe(true)
			const slug = branchName.replace('feat/issue-222-', '')
			expect(slug.length).toBeLessThanOrEqual(20)
		})

		it('should handle titles with only special characters', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(333, '!!!')
			expect(branchName).toBe('feat/issue-333-')
		})
	})

	describe('ClaudeBranchNameStrategy', () => {
		it('should delegate to generateBranchName from claude.js', async () => {
			const strategy = new ClaudeBranchNameStrategy()
			const branchName = await strategy.generate(123, 'Test Issue')

			// Verify the mock was called with correct arguments
			const { generateBranchName } = await import('../utils/claude.js')
			expect(generateBranchName).toHaveBeenCalledWith('Test Issue', 123, 'haiku')
			// The mock should return the mocked value
			expect(branchName).toBe('feat/issue-123-ai-generated-branch')
		})

		it('should use custom claude model when specified', async () => {
			const strategy = new ClaudeBranchNameStrategy('sonnet')
			await strategy.generate(456, 'Another Issue')

			const { generateBranchName } = await import('../utils/claude.js')
			expect(generateBranchName).toHaveBeenCalledWith('Another Issue', 456, 'sonnet')
		})

		it('should use haiku model by default', async () => {
			const strategy = new ClaudeBranchNameStrategy()
			await strategy.generate(789, 'Default Model Test')

			const { generateBranchName } = await import('../utils/claude.js')
			expect(generateBranchName).toHaveBeenCalledWith('Default Model Test', 789, 'haiku')
		})
	})
})
