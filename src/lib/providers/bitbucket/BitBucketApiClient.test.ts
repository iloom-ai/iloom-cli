import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BitBucketApiClient, type BitBucketConfig } from './BitBucketApiClient.js'

// Mock the https module
vi.mock('node:https', () => ({
	default: {
		request: vi.fn(),
	},
}))

// Mock the logger
vi.mock('../../../utils/logger-context.js', () => ({
	getLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}))

describe('BitBucketApiClient', () => {
	let client: BitBucketApiClient
	const config: BitBucketConfig = {
		username: 'testuser',
		apiToken: 'test-api-token',
		workspace: 'test-workspace',
		repoSlug: 'test-repo',
	}

	beforeEach(() => {
		client = new BitBucketApiClient(config)
	})

	describe('createPullRequest', () => {
		it('should include reviewers in payload when provided', async () => {
			const https = await import('node:https')
			let capturedPayload: string | undefined

			// Mock the request to capture the payload
			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 201,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								id: 123,
								title: 'Test PR',
								links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
							}))
						}
						if (event === 'end') {
							handler()
						}
						return mockResponse
					}),
				}
				// @ts-expect-error - Mock callback
				callback(mockResponse)
				return {
					on: vi.fn(),
					write: (data: string) => { capturedPayload = data },
					end: vi.fn(),
				}
			})

			await client.createPullRequest(
				'workspace',
				'repo',
				'Test PR',
				'Test description',
				'feature-branch',
				'main',
				['account-id-1', 'account-id-2']
			)

			expect(capturedPayload).toBeDefined()
			const payload = JSON.parse(capturedPayload!)
			expect(payload.reviewers).toEqual([
				{ account_id: 'account-id-1' },
				{ account_id: 'account-id-2' },
			])
		})

		it('should not include reviewers in payload when not provided', async () => {
			const https = await import('node:https')
			let capturedPayload: string | undefined

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 201,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								id: 123,
								title: 'Test PR',
								links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
							}))
						}
						if (event === 'end') {
							handler()
						}
						return mockResponse
					}),
				}
				// @ts-expect-error - Mock callback
				callback(mockResponse)
				return {
					on: vi.fn(),
					write: (data: string) => { capturedPayload = data },
					end: vi.fn(),
				}
			})

			await client.createPullRequest(
				'workspace',
				'repo',
				'Test PR',
				'Test description',
				'feature-branch',
				'main'
			)

			expect(capturedPayload).toBeDefined()
			const payload = JSON.parse(capturedPayload!)
			expect(payload.reviewers).toBeUndefined()
		})

		it('should not include reviewers when array is empty', async () => {
			const https = await import('node:https')
			let capturedPayload: string | undefined

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 201,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								id: 123,
								title: 'Test PR',
								links: { html: { href: 'https://bitbucket.org/test/pr/123' } },
							}))
						}
						if (event === 'end') {
							handler()
						}
						return mockResponse
					}),
				}
				// @ts-expect-error - Mock callback
				callback(mockResponse)
				return {
					on: vi.fn(),
					write: (data: string) => { capturedPayload = data },
					end: vi.fn(),
				}
			})

			await client.createPullRequest(
				'workspace',
				'repo',
				'Test PR',
				'Test description',
				'feature-branch',
				'main',
				[]
			)

			expect(capturedPayload).toBeDefined()
			const payload = JSON.parse(capturedPayload!)
			expect(payload.reviewers).toBeUndefined()
		})
	})

	describe('findUsersByUsername', () => {
		it('should return map of username to account_id for matched users', async () => {
			const https = await import('node:https')

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 200,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								values: [
									{ user: { account_id: 'acc-1', display_name: 'Alice Test', uuid: 'uuid-1', nickname: 'alice' } },
									{ user: { account_id: 'acc-2', display_name: 'Bob Example', uuid: 'uuid-2', nickname: 'bob' } },
								],
							}))
						}
						if (event === 'end') {
							handler()
						}
						return mockResponse
					}),
				}
				// @ts-expect-error - Mock callback
				callback(mockResponse)
				return {
					on: vi.fn(),
					write: vi.fn(),
					end: vi.fn(),
				}
			})

			const result = await client.findUsersByUsername('workspace', ['alice', 'bob'])

			expect(result.get('alice')).toBe('acc-1')
			expect(result.get('bob')).toBe('acc-2')
		})

		it('should return empty map when no users match', async () => {
			const https = await import('node:https')

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 200,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								values: [
									{ user: { account_id: 'acc-1', display_name: 'Charlie Different', uuid: 'uuid-1', nickname: 'charlie' } },
								],
							}))
						}
						if (event === 'end') {
							handler()
						}
						return mockResponse
					}),
				}
				// @ts-expect-error - Mock callback
				callback(mockResponse)
				return {
					on: vi.fn(),
					write: vi.fn(),
					end: vi.fn(),
				}
			})

			const result = await client.findUsersByUsername('workspace', ['alice'])

			expect(result.size).toBe(0)
		})

		it('should handle API errors by throwing', async () => {
			const https = await import('node:https')

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 403,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({ error: { message: 'Access denied' } }))
						}
						if (event === 'end') {
							handler()
						}
						return mockResponse
					}),
				}
				// @ts-expect-error - Mock callback
				callback(mockResponse)
				return {
					on: vi.fn(),
					write: vi.fn(),
					end: vi.fn(),
				}
			})

			// Should throw on API error
			await expect(client.findUsersByUsername('workspace', ['alice'])).rejects.toThrow('BitBucket API error')
		})

		it('should handle pagination when fetching workspace members', async () => {
			const https = await import('node:https')
			let requestCount = 0
			const requestPaths: string[] = []

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				requestCount++
				// Capture the path used in each request to verify no URL duplication
				requestPaths.push((options as { path: string }).path)
				const mockResponse = {
					statusCode: 200,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							// First request returns first page with 'next' URL
							if (requestCount === 1) {
								handler(JSON.stringify({
									values: [
										{ user: { account_id: 'acc-1', display_name: 'Alice Test', uuid: 'uuid-1', nickname: 'alice' } },
									],
									next: 'https://api.bitbucket.org/2.0/workspaces/workspace/members?page=2',
								}))
							} else {
								// Second request returns second page without 'next'
								handler(JSON.stringify({
									values: [
										{ user: { account_id: 'acc-2', display_name: 'Bob Example', uuid: 'uuid-2', nickname: 'bob' } },
									],
								}))
							}
						}
						if (event === 'end') {
							handler()
						}
						return mockResponse
					}),
				}
				// @ts-expect-error - Mock callback
				callback(mockResponse)
				return {
					on: vi.fn(),
					write: vi.fn(),
					end: vi.fn(),
				}
			})

			const result = await client.findUsersByUsername('workspace', ['alice', 'bob'])

			// Should have made 2 requests (one for each page)
			expect(requestCount).toBe(2)
			// Should have found both users from different pages
			expect(result.get('alice')).toBe('acc-1')
			expect(result.get('bob')).toBe('acc-2')
			// Verify no URL path duplication (bug fix verification)
			// First request should be the initial endpoint
			expect(requestPaths[0]).toBe('/2.0/workspaces/workspace/members')
			// Second request should be the pagination path (not /2.0/2.0/...)
			expect(requestPaths[1]).toBe('/2.0/workspaces/workspace/members?page=2')
		})

		it('should match by display_name when nickname does not match', async () => {
			const https = await import('node:https')

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 200,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								values: [
									{ user: { account_id: 'acc-1', display_name: 'alice', uuid: 'uuid-1', nickname: 'alice123' } },
								],
							}))
						}
						if (event === 'end') {
							handler()
						}
						return mockResponse
					}),
				}
				// @ts-expect-error - Mock callback
				callback(mockResponse)
				return {
					on: vi.fn(),
					write: vi.fn(),
					end: vi.fn(),
				}
			})

			const result = await client.findUsersByUsername('workspace', ['alice'])

			expect(result.get('alice')).toBe('acc-1')
		})
	})

	describe('getCurrentUser', () => {
		it('should return current user data from /user endpoint', async () => {
			const https = await import('node:https')

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 200,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								account_id: 'acc-current-user',
								display_name: 'Current User',
								nickname: 'currentuser',
							}))
						}
						if (event === 'end') {
							handler()
						}
						return mockResponse
					}),
				}
				// @ts-expect-error - Mock callback
				callback(mockResponse)
				return {
					on: vi.fn(),
					write: vi.fn(),
					end: vi.fn(),
				}
			})

			const user = await client.getCurrentUser()

			expect(user.account_id).toBe('acc-current-user')
			expect(user.display_name).toBe('Current User')
			expect(user.nickname).toBe('currentuser')
		})

		it('should throw on API error', async () => {
			const https = await import('node:https')

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 401,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({ error: { message: 'Unauthorized' } }))
						}
						if (event === 'end') {
							handler()
						}
						return mockResponse
					}),
				}
				// @ts-expect-error - Mock callback
				callback(mockResponse)
				return {
					on: vi.fn(),
					write: vi.fn(),
					end: vi.fn(),
				}
			})

			await expect(client.getCurrentUser()).rejects.toThrow('BitBucket API error')
		})
	})

	describe('getWorkspace', () => {
		it('should return configured workspace', () => {
			expect(client.getWorkspace()).toBe('test-workspace')
		})
	})

	describe('getRepoSlug', () => {
		it('should return configured repoSlug', () => {
			expect(client.getRepoSlug()).toBe('test-repo')
		})
	})
})
