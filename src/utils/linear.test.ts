import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted shared mock — accessible from both vi.mock factory and test bodies
const { mockIssueFn } = vi.hoisted(() => ({ mockIssueFn: vi.fn() }))

// Mock @linear/sdk LinearClient before importing the module under test
vi.mock('@linear/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@linear/sdk')>()
	return {
		...actual,
		LinearClient: vi.fn(),
	}
})

import { LinearClient } from '@linear/sdk'
import { fetchLinearIssue } from './linear.js'

describe('fetchLinearIssue', () => {
	const baseIssue = {
		id: 'uuid-123',
		identifier: 'ENG-123',
		title: 'Test Issue',
		description: 'Body text',
		url: 'https://linear.app/issue/ENG-123',
		createdAt: new Date('2024-01-01T00:00:00Z'),
		updatedAt: new Date('2024-01-02T00:00:00Z'),
		state: Promise.resolve({ name: 'Todo' }),
	}

	beforeEach(() => {
		process.env.LINEAR_API_TOKEN = 'test-token'
		// Re-establish LinearClient impl after global mockReset wipes it between tests
		vi.mocked(LinearClient).mockImplementation(
			() => ({ issue: mockIssueFn }) as unknown as LinearClient,
		)
	})

	it('returns issue with attachments when SDK returns attachment nodes', async () => {
		const attachmentsFn = vi.fn().mockResolvedValue({
			nodes: [
				{
					id: 'att-1',
					url: 'https://uploads.linear.app/abc/image.png',
					title: 'Screenshot',
					subtitle: 'A screenshot',
				},
				{
					id: 'att-2',
					url: 'https://example.com/file.pdf',
					title: 'Document',
					subtitle: undefined,
				},
			],
		})

		mockIssueFn.mockResolvedValue({
			...baseIssue,
			attachments: attachmentsFn,
		})

		const result = await fetchLinearIssue('ENG-123')

		expect(result.attachments).toHaveLength(2)
		expect(result.attachments?.[0]).toEqual({
			id: 'att-1',
			url: 'https://uploads.linear.app/abc/image.png',
			title: 'Screenshot',
			subtitle: 'A screenshot',
		})
		expect(result.attachments?.[1]).toEqual({
			id: 'att-2',
			url: 'https://example.com/file.pdf',
			title: 'Document',
		})
	})

	it('returns issue without attachments when SDK returns empty connection', async () => {
		const attachmentsFn = vi.fn().mockResolvedValue({ nodes: [] })

		mockIssueFn.mockResolvedValue({
			...baseIssue,
			attachments: attachmentsFn,
		})

		const result = await fetchLinearIssue('ENG-123')

		expect(result.attachments).toBeUndefined()
		expect(result.identifier).toBe('ENG-123')
	})

	it('returns issue without attachments (and does not throw) when issue.attachments() rejects', async () => {
		const attachmentsFn = vi.fn().mockRejectedValue(new Error('API failure'))

		mockIssueFn.mockResolvedValue({
			...baseIssue,
			attachments: attachmentsFn,
		})

		const result = await fetchLinearIssue('ENG-123')

		expect(result.attachments).toBeUndefined()
		expect(result.identifier).toBe('ENG-123')
		expect(result.title).toBe('Test Issue')
	})
})
