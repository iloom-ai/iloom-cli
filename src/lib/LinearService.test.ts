import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LinearService } from './LinearService.js'

// Mock the linear utils module
vi.mock('../utils/linear.js', () => ({
	fetchLinearIssue: vi.fn(),
	createLinearIssue: vi.fn(),
	updateLinearIssueState: vi.fn(),
}))

describe('LinearService', () => {
	describe('formatIssueId', () => {
		it('should uppercase a lowercase identifier', () => {
			const service = new LinearService()
			expect(service.formatIssueId('eng-123')).toBe('ENG-123')
		})

		it('should keep already-uppercase identifiers unchanged', () => {
			const service = new LinearService()
			expect(service.formatIssueId('ENG-456')).toBe('ENG-456')
		})

		it('should handle mixed case', () => {
			const service = new LinearService()
			expect(service.formatIssueId('Eng-789')).toBe('ENG-789')
		})

		it('should convert numeric identifier to uppercase string', () => {
			const service = new LinearService()
			expect(service.formatIssueId(123)).toBe('123')
		})
	})

	describe('constructor', () => {
		let originalToken: string | undefined

		beforeEach(() => {
			// Save original env value
			originalToken = process.env.LINEAR_API_TOKEN
			// Clear the env var for testing
			delete process.env.LINEAR_API_TOKEN
		})

		afterEach(() => {
			// Restore original env value
			if (originalToken !== undefined) {
				process.env.LINEAR_API_TOKEN = originalToken
			} else {
				delete process.env.LINEAR_API_TOKEN
			}
		})

		it('should set LINEAR_API_TOKEN env var when apiToken provided in config', () => {
			const testToken = 'lin_api_test_token_123'
			new LinearService({ apiToken: testToken })

			expect(process.env.LINEAR_API_TOKEN).toBe(testToken)
		})

		it('should not set LINEAR_API_TOKEN if not provided in config', () => {
			new LinearService({ teamId: 'ENG' })

			expect(process.env.LINEAR_API_TOKEN).toBeUndefined()
		})

		it('should not set LINEAR_API_TOKEN if config is undefined', () => {
			new LinearService()

			expect(process.env.LINEAR_API_TOKEN).toBeUndefined()
		})

		it('should override existing LINEAR_API_TOKEN when apiToken provided in config', () => {
			process.env.LINEAR_API_TOKEN = 'existing_token'
			const newToken = 'lin_api_new_token'

			new LinearService({ apiToken: newToken })

			expect(process.env.LINEAR_API_TOKEN).toBe(newToken)
		})

		it('should preserve existing LINEAR_API_TOKEN when apiToken not provided', () => {
			const existingToken = 'existing_token'
			process.env.LINEAR_API_TOKEN = existingToken

			new LinearService({ teamId: 'ENG' })

			expect(process.env.LINEAR_API_TOKEN).toBe(existingToken)
		})
	})
})
