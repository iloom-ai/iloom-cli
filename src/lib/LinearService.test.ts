import { describe, it, expect, vi } from 'vitest'
import { LinearService } from './LinearService.js'
import { fetchLinearIssue, createLinearIssue, updateLinearIssueState } from '../utils/linear.js'

vi.mock('../utils/linear.js', () => ({
	fetchLinearIssue: vi.fn(),
	createLinearIssue: vi.fn(),
	updateLinearIssueState: vi.fn(),
}))

describe('LinearService', () => {
	const testToken = 'lin_api_test_token_123'

	describe('constructor', () => {
		it('should not set process.env.LINEAR_API_TOKEN when apiToken provided', () => {
			delete process.env.LINEAR_API_TOKEN
			new LinearService({ apiToken: testToken })
			expect(process.env.LINEAR_API_TOKEN).toBeUndefined()
		})
	})

	describe('fetchIssue', () => {
		it('should pass apiToken to fetchLinearIssue when configured', async () => {
			vi.mocked(fetchLinearIssue).mockResolvedValue({
				id: 'uuid-1',
				identifier: 'ENG-123',
				title: 'Test Issue',
				url: 'https://linear.app/issue/ENG-123',
				createdAt: '2024-01-01T00:00:00.000Z',
				updatedAt: '2024-01-01T00:00:00.000Z',
			})
			const service = new LinearService({ apiToken: testToken })
			await service.fetchIssue('ENG-123')
			expect(fetchLinearIssue).toHaveBeenCalledWith('ENG-123', testToken)
		})

		it('should pass undefined when apiToken not configured', async () => {
			vi.mocked(fetchLinearIssue).mockResolvedValue({
				id: 'uuid-1',
				identifier: 'ENG-123',
				title: 'Test Issue',
				url: 'https://linear.app/issue/ENG-123',
				createdAt: '2024-01-01T00:00:00.000Z',
				updatedAt: '2024-01-01T00:00:00.000Z',
			})
			const service = new LinearService({ teamId: 'ENG' })
			await service.fetchIssue('ENG-123')
			expect(fetchLinearIssue).toHaveBeenCalledWith('ENG-123', undefined)
		})
	})

	describe('createIssue', () => {
		it('should pass apiToken to createLinearIssue when configured', async () => {
			vi.mocked(createLinearIssue).mockResolvedValue({
				identifier: 'ENG-456',
				url: 'https://linear.app/issue/ENG-456',
			})
			const service = new LinearService({ apiToken: testToken, teamId: 'ENG' })
			await service.createIssue('Title', 'Body', undefined, ['bug'])
			expect(createLinearIssue).toHaveBeenCalledWith('Title', 'Body', 'ENG', ['bug'], testToken)
		})

		it('should pass undefined when apiToken not configured', async () => {
			vi.mocked(createLinearIssue).mockResolvedValue({
				identifier: 'ENG-456',
				url: 'https://linear.app/issue/ENG-456',
			})
			const service = new LinearService({ teamId: 'ENG' })
			await service.createIssue('Title', 'Body', undefined, ['bug'])
			expect(createLinearIssue).toHaveBeenCalledWith('Title', 'Body', 'ENG', ['bug'], undefined)
		})
	})

	describe('moveIssueToInProgress', () => {
		it('should pass apiToken to updateLinearIssueState when configured', async () => {
			vi.mocked(updateLinearIssueState).mockResolvedValue(undefined)
			const service = new LinearService({ apiToken: testToken })
			await service.moveIssueToInProgress('ENG-123')
			expect(updateLinearIssueState).toHaveBeenCalledWith('ENG-123', 'In Progress', testToken)
		})

		it('should pass undefined when apiToken not configured', async () => {
			vi.mocked(updateLinearIssueState).mockResolvedValue(undefined)
			const service = new LinearService()
			await service.moveIssueToInProgress('ENG-123')
			expect(updateLinearIssueState).toHaveBeenCalledWith('ENG-123', 'In Progress', undefined)
		})
	})
})
