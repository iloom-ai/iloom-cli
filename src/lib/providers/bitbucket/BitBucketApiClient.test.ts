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

	describe('addPRComment', () => {
		it('should return comment id and url from response', async () => {
			const https = await import('node:https')

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 201,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								id: 456,
								content: { raw: 'Test comment' },
								links: { html: { href: 'https://bitbucket.org/workspace/repo/pull-requests/1#comment-456' } },
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

			const result = await client.addPRComment('workspace', 'repo', 1, 'Test comment')

			expect(result.id).toBe(456)
			expect(result.links.html.href).toBe('https://bitbucket.org/workspace/repo/pull-requests/1#comment-456')
			expect(result.content.raw).toBe('Test comment')
		})
	})

	describe('put method support', () => {
		it('should send PUT requests to BitBucket API', async () => {
			const https = await import('node:https')
			let capturedMethod: string | undefined

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				capturedMethod = (options as { method: string }).method
				const mockResponse = {
					statusCode: 200,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								id: 789,
								content: { raw: 'Updated comment' },
								links: { html: { href: 'https://bitbucket.org/workspace/repo/pull-requests/1#comment-789' } },
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

			await client.updatePRComment('workspace', 'repo', 1, 789, 'Updated comment')

			expect(capturedMethod).toBe('PUT')
		})
	})

	describe('updatePRComment', () => {
		it('should PUT to correct endpoint with content body', async () => {
			const https = await import('node:https')
			let capturedPath: string | undefined
			let capturedPayload: string | undefined

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				capturedPath = (options as { path: string }).path
				const mockResponse = {
					statusCode: 200,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								id: 42,
								content: { raw: 'Updated text' },
								links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/5#comment-42' } },
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

			const result = await client.updatePRComment('ws', 'repo', 5, 42, 'Updated text')

			expect(capturedPath).toBe('/2.0/repositories/ws/repo/pullrequests/5/comments/42')
			expect(capturedPayload).toBeDefined()
			const payload = JSON.parse(capturedPayload!)
			expect(payload).toEqual({ content: { raw: 'Updated text' } })
			expect(result.id).toBe(42)
			expect(result.links.html.href).toBe('https://bitbucket.org/ws/repo/pull-requests/5#comment-42')
		})
	})

	describe('listPRComments', () => {
		it('should GET PR comments and return all from single page', async () => {
			const https = await import('node:https')

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				const mockResponse = {
					statusCode: 200,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								values: [
									{
										id: 1,
										content: { raw: 'General comment' },
										links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/10#comment-1' } },
									},
									{
										id: 2,
										content: { raw: 'Inline comment' },
										inline: { from: null, to: 15, path: 'src/main.ts' },
										links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/10#comment-2' } },
									},
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

			const comments = await client.listPRComments('ws', 'repo', 10)

			expect(comments).toHaveLength(2)
			expect(comments[0].id).toBe(1)
			expect(comments[0].inline).toBeUndefined()
			expect(comments[1].id).toBe(2)
			expect(comments[1].inline).toEqual({ from: null, to: 15, path: 'src/main.ts' })
		})

		it('should handle pagination when fetching PR comments', async () => {
			const https = await import('node:https')
			let requestCount = 0

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				requestCount++
				const mockResponse = {
					statusCode: 200,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							if (requestCount === 1) {
								handler(JSON.stringify({
									values: [
										{
											id: 1,
											content: { raw: 'Comment 1' },
											links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/10#comment-1' } },
										},
									],
									next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/10/comments?page=2',
								}))
							} else {
								handler(JSON.stringify({
									values: [
										{
											id: 2,
											content: { raw: 'Comment 2' },
											links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/10#comment-2' } },
										},
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

			const comments = await client.listPRComments('ws', 'repo', 10)

			expect(requestCount).toBe(2)
			expect(comments).toHaveLength(2)
			expect(comments[0].id).toBe(1)
			expect(comments[1].id).toBe(2)
		})
	})

	describe('addInlinePRComment', () => {
		it('should POST with inline metadata', async () => {
			const https = await import('node:https')
			let capturedPayload: string | undefined
			let capturedPath: string | undefined

			vi.mocked(https.default.request).mockImplementation((options, callback) => {
				capturedPath = (options as { path: string }).path
				const mockResponse = {
					statusCode: 201,
					on: vi.fn((event, handler) => {
						if (event === 'data') {
							handler(JSON.stringify({
								id: 99,
								content: { raw: 'Inline review note' },
								inline: { from: null, to: 42, path: 'src/utils/helper.ts' },
								links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7#comment-99' } },
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

			const result = await client.addInlinePRComment('ws', 'repo', 7, 'Inline review note', 'src/utils/helper.ts', 42)

			expect(capturedPath).toBe('/2.0/repositories/ws/repo/pullrequests/7/comments')
			expect(capturedPayload).toBeDefined()
			const payload = JSON.parse(capturedPayload!)
			expect(payload).toEqual({
				content: { raw: 'Inline review note' },
				inline: { to: 42, path: 'src/utils/helper.ts' },
			})
			expect(result.id).toBe(99)
			expect(result.inline).toEqual({ from: null, to: 42, path: 'src/utils/helper.ts' })
			expect(result.links.html.href).toBe('https://bitbucket.org/ws/repo/pull-requests/7#comment-99')
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
