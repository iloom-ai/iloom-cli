import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
	DefaultBranchNamingService,
	SimpleBranchNameStrategy,
	ClaudeBranchNameStrategy,
	TemplateBranchNameStrategy,
	slugify,
	type BranchNameStrategy,
} from './BranchNamingService.js'

// Hoist the mock factory to ensure it's available before module resolution
const mockGenerateBranchName = vi.fn()

vi.mock('../utils/claude.js', () => ({
	generateBranchName: mockGenerateBranchName,
}))

// Setup the mock return value
beforeEach(() => {
	mockGenerateBranchName.mockResolvedValue('feat/issue-123__ai-generated-branch')
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
				expect(branchName).toBe('feat/issue-123__test-issue-title')
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
				expect(firstBranch).toBe('feat/issue-100__test')

				// Change to Claude strategy
				service.setDefaultStrategy(new ClaudeBranchNameStrategy())
				const secondBranch = await service.generateBranchName({
					issueNumber: 200,
					title: 'Test',
				})
				// The mock always returns the same value, so this will be the mocked value
				expect(secondBranch).toBe('feat/issue-123__ai-generated-branch')
			})
		})
	})

	describe('SimpleBranchNameStrategy', () => {
		it('should generate branch name with feat prefix', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(123, 'Add new feature')
			expect(branchName).toBe('feat/issue-123__add-new-feature')
		})

		it('should convert title to lowercase', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(456, 'UPPERCASE TITLE')
			expect(branchName).toBe('feat/issue-456__uppercase-title')
		})

		it('should replace non-alphanumeric characters with hyphens', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(789, 'Fix bug #123 & issue')
			expect(branchName).toBe('feat/issue-789__fix-bug-123-issue')
		})

		it('should trim leading and trailing hyphens', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(111, '---start and end---')
			expect(branchName).toBe('feat/issue-111__start-and-end')
		})

		it('should truncate slug to 20 characters', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(
				222,
				'This is a very long title that should be truncated'
			)
			// The slug is truncated to 20 characters, which may end with a hyphen
			expect(branchName.startsWith('feat/issue-222__this-is-a-very-long')).toBe(true)
			const slug = branchName.replace('feat/issue-222__', '')
			expect(slug.length).toBeLessThanOrEqual(20)
		})

		it('should handle titles with only special characters', async () => {
			const strategy = new SimpleBranchNameStrategy()
			const branchName = await strategy.generate(333, '!!!')
			expect(branchName).toBe('feat/issue-333__')
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
			expect(branchName).toBe('feat/issue-123__ai-generated-branch')
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

	describe('TemplateBranchNameStrategy', () => {
		it('should substitute {ticketId} and {slug}', async () => {
			const strategy = new TemplateBranchNameStrategy('{ticketId}-{slug}')
			const branchName = await strategy.generate('PRINT-1234', 'Fix dependency bug')
			expect(branchName).toBe('print-1234-fix-dependency-bug')
		})

		it('should handle Jira-style issue keys', async () => {
			const strategy = new TemplateBranchNameStrategy('{ticketId}-{slug}')
			const branchName = await strategy.generate('HB-42', 'Add dark mode toggle')
			expect(branchName).toBe('hb-42-add-dark-mode-toggle')
		})

		it('should handle template with only ticketId', async () => {
			const strategy = new TemplateBranchNameStrategy('{ticketId}')
			const branchName = await strategy.generate('PROJ-99', 'Some title')
			expect(branchName).toBe('proj-99')
		})

		it('should handle template with slashes', async () => {
			const strategy = new TemplateBranchNameStrategy('feature/{ticketId}-{slug}')
			const branchName = await strategy.generate('ENG-500', 'Update auth flow')
			expect(branchName).toBe('feature/eng-500-update-auth-flow')
		})

		it('should truncate slug to 40 characters', async () => {
			const strategy = new TemplateBranchNameStrategy('{ticketId}-{slug}')
			const branchName = await strategy.generate(
				'PRINT-1',
				'This is a very long title that should definitely be truncated at some point'
			)
			const slug = branchName.replace('print-1-', '')
			expect(slug.length).toBeLessThanOrEqual(40)
		})

		it('should remove trailing hyphens', async () => {
			const strategy = new TemplateBranchNameStrategy('{ticketId}-{slug}')
			const branchName = await strategy.generate('X-1', '!!!')
			expect(branchName).toBe('x-1')
		})
	})

	describe('slugify', () => {
		it('should convert to lowercase and replace special chars', () => {
			expect(slugify('Fix Bug #123')).toBe('fix-bug-123')
		})

		it('should respect maxLength', () => {
			expect(slugify('a very long string here', 10).length).toBeLessThanOrEqual(10)
		})

		it('should trim leading and trailing hyphens', () => {
			expect(slugify('---hello---')).toBe('hello')
		})
	})

	describe('DefaultBranchNamingService with branchFormat', () => {
		it('should use TemplateBranchNameStrategy when branchFormat is provided', async () => {
			const service = new DefaultBranchNamingService({ useClaude: false })
			const branchName = await service.generateBranchName({
				issueNumber: 'PRINT-1234',
				title: 'Fix deps bug',
				branchFormat: '{ticketId}-{slug}',
			})
			expect(branchName).toBe('print-1234-fix-deps-bug')
		})

		it('should prefer explicit strategy over branchFormat', async () => {
			class CustomStrategy implements BranchNameStrategy {
				async generate(): Promise<string> {
					return 'custom/branch'
				}
			}
			const service = new DefaultBranchNamingService({ useClaude: false })
			const branchName = await service.generateBranchName({
				issueNumber: 'PRINT-1234',
				title: 'Fix deps bug',
				strategy: new CustomStrategy(),
				branchFormat: '{ticketId}-{slug}',
			})
			expect(branchName).toBe('custom/branch')
		})

		it('should fall back to default strategy when no branchFormat', async () => {
			const service = new DefaultBranchNamingService({ useClaude: false })
			const branchName = await service.generateBranchName({
				issueNumber: 123,
				title: 'Test Issue',
			})
			expect(branchName).toBe('feat/issue-123__test-issue')
		})
	})
})
