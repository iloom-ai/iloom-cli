import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LinearService } from './LinearService.js'

// Mock the linear utils module
vi.mock('../utils/linear.js', () => ({
	fetchLinearIssue: vi.fn(),
	createLinearIssue: vi.fn(),
	updateLinearIssueState: vi.fn(),
	getLinearChildIssues: vi.fn(),
}))

import { getLinearChildIssues } from '../utils/linear.js'

describe('LinearService', () => {
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

	describe('getChildIssues', () => {
		it('should call getLinearChildIssues with identifier', async () => {
			const mockChildren = [
				{ id: 'ENG-101', title: 'Sub-task', url: 'https://linear.app/issue/ENG-101', state: 'In Progress' },
			]
			vi.mocked(getLinearChildIssues).mockResolvedValue(mockChildren)

			const service = new LinearService()
			const result = await service.getChildIssues('ENG-100')

			expect(getLinearChildIssues).toHaveBeenCalledWith('ENG-100', undefined)
			expect(result).toEqual(mockChildren)
		})

		it('should pass apiToken from config when available', async () => {
			vi.mocked(getLinearChildIssues).mockResolvedValue([])

			const service = new LinearService({ apiToken: 'lin_api_test' })
			await service.getChildIssues('ENG-100')

			expect(getLinearChildIssues).toHaveBeenCalledWith('ENG-100', { apiToken: 'lin_api_test' })
		})

		it('should pass undefined options when no apiToken configured', async () => {
			vi.mocked(getLinearChildIssues).mockResolvedValue([])

			const service = new LinearService({ teamId: 'ENG' })
			await service.getChildIssues('ENG-100')

			expect(getLinearChildIssues).toHaveBeenCalledWith('ENG-100', undefined)
		})
	})
})
