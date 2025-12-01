import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execa, type ExecaReturnValue } from 'execa'
import {
	executeGhCommand,
	checkGhAuth,
	hasProjectScope,
	fetchGhIssue,
	fetchGhPR,
	fetchProjectList,
	fetchProjectItems,
	fetchProjectFields,
	updateProjectItemField,
	createIssue,
	createIssueComment,
	updateIssueComment,
	createPRComment,
	getRepoInfo,
} from './github.js'

vi.mock('execa')

type MockExecaReturn = Partial<ExecaReturnValue<string>>

describe('github utils', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('executeGhCommand', () => {
		it('should execute gh command successfully', async () => {
			const expectedOutput = 'issue list output'
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: expectedOutput,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await executeGhCommand<string>(['issue', 'list'])

			expect(result).toBe(expectedOutput)
			expect(execa).toHaveBeenCalledWith(
				'gh',
				['issue', 'list'],
				expect.objectContaining({
					timeout: 30000,
					encoding: 'utf8',
				})
			)
		})

		it('should parse JSON output when --json flag is present', async () => {
			const jsonData = { number: 123, title: 'Test' }
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(jsonData),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await executeGhCommand(['issue', 'view', '123', '--json'])

			expect(result).toEqual(jsonData)
		})

		it('should handle command failure', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'Could not resolve',
				message: 'Command failed',
				exitCode: 1,
			})

			await expect(executeGhCommand(['issue', 'view', '999'])).rejects.toThrow('Command failed')
		})

		it('should use custom timeout when provided', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'command output',
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await executeGhCommand<string>(['issue', 'list'], { timeout: 60000 })

			expect(result).toBe('command output')

			expect(execa).toHaveBeenCalledWith(
				'gh',
				['issue', 'list'],
				expect.objectContaining({
					timeout: 60000,
				})
			)
		})

		it('should use custom cwd when provided', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'command output',
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await executeGhCommand<string>(['issue', 'list'], { cwd: '/custom/path' })

			expect(result).toBe('command output')

			expect(execa).toHaveBeenCalledWith(
				'gh',
				['issue', 'list'],
				expect.objectContaining({
					cwd: '/custom/path',
				})
			)
		})
	})

	describe('checkGhAuth', () => {
		it('should return auth status when authenticated (old format)', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'Logged in to github.com as testuser\nToken scopes: repo, project',
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const status = await checkGhAuth()

			expect(status.hasAuth).toBe(true)
			expect(status.scopes).toEqual(['repo', 'project'])
			expect(status.username).toBe('testuser')
		})

		it('should return auth status when authenticated (new format - single account)', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: `github.com
  ✓ Logged in to github.com account testuser (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'repo', 'project'`,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const status = await checkGhAuth()

			expect(status.hasAuth).toBe(true)
			expect(status.scopes).toEqual(['repo', 'project'])
			expect(status.username).toBe('testuser')
		})

		it('should return active account when multiple accounts (new format)', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: `github.com
  ✓ Logged in to github.com account testuser (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'repo', 'project'

  ✓ Logged in to github.com account otheruser (keyring)
  - Active account: false
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org'`,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const status = await checkGhAuth()

			expect(status.hasAuth).toBe(true)
			expect(status.scopes).toEqual(['repo', 'project'])
			expect(status.username).toBe('testuser')
		})

		it('should return not authenticated when gh reports no login', async () => {
			const error = new Error('Failed') as Error & { stderr?: string }
			error.stderr = 'You are not logged into any GitHub hosts'
			vi.mocked(execa).mockRejectedValueOnce(error)

			const status = await checkGhAuth()

			expect(status.hasAuth).toBe(false)
			expect(status.scopes).toEqual([])
		})

		it('should throw for other errors', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'Network error',
				message: 'Failed',
				exitCode: 1,
			})

			await expect(checkGhAuth()).rejects.toThrow('Failed')
		})

		it('should handle missing scope information', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'Logged in to github.com as testuser',
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const status = await checkGhAuth()

			expect(status.hasAuth).toBe(true)
			expect(status.scopes).toEqual([])
			expect(status.username).toBe('testuser')
		})
	})

	describe('hasProjectScope', () => {
		it('should return true when project scope exists', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'Token scopes: repo, project',
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const hasScope = await hasProjectScope()

			expect(hasScope).toBe(true)
		})

		it('should return false when project scope missing', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'Token scopes: repo',
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const hasScope = await hasProjectScope()

			expect(hasScope).toBe(false)
		})

		// Tests for real-world GitHub CLI output with quoted scopes
		it('should return true when project scope exists in quoted format (real GitHub CLI output)', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: `github.com
  ✓ Logged in to github.com account acreeger (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'project', 'read:org', 'repo'`,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const hasScope = await hasProjectScope()

			expect(hasScope).toBe(true)
		})

		it('should return false when project scope missing in quoted format', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: `github.com
  ✓ Logged in to github.com account testuser (keyring)
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'`,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const hasScope = await hasProjectScope()

			expect(hasScope).toBe(false)
		})

		it('should handle mixed quoted and unquoted scopes', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: `Token scopes: 'admin:public_key', gist, 'project', repo`,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const hasScope = await hasProjectScope()

			expect(hasScope).toBe(true)
		})
	})

	describe('fetchGhIssue', () => {
		it('should fetch issue with correct parameters', async () => {
			const issueData = {
				number: 123,
				title: 'Test Issue',
				state: 'OPEN',
			}

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(issueData),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await fetchGhIssue(123)

			expect(result).toEqual(issueData)
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'issue',
					'view',
					'123',
					'--json',
					'number,title,body,state,labels,assignees,url,createdAt,updatedAt',
				],
				expect.any(Object)
			)
		})
	})

	describe('fetchGhPR', () => {
		it('should fetch PR with correct parameters', async () => {
			const prData = {
				number: 456,
				title: 'Test PR',
				state: 'OPEN',
			}

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(prData),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await fetchGhPR(456)

			expect(result).toEqual(prData)
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'pr',
					'view',
					'456',
					'--json',
					'number,title,body,state,headRefName,baseRefName,url,isDraft,mergeable,createdAt,updatedAt',
				],
				expect.any(Object)
			)
		})
	})

	describe('fetchProjectList', () => {
		it('should fetch project list for owner', async () => {
			const projectData = {
				projects: [
					{ number: 1, id: 'proj-1', name: 'Project 1', fields: [] },
				],
			}

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(projectData),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await fetchProjectList('testowner')

			expect(result).toEqual(projectData.projects)
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'project',
					'list',
					'--owner',
					'testowner',
					'--limit',
					'100',
					'--format',
					'json',
				],
				expect.any(Object)
			)
		})
	})

	describe('fetchProjectItems', () => {
		it('should fetch project items', async () => {
			const itemsData = {
				items: [{ id: 'item-1', content: { type: 'Issue', number: 123 } }],
			}

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(itemsData),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await fetchProjectItems(1, 'testowner')

			expect(result).toEqual(itemsData.items)
		})
	})

	describe('fetchProjectFields', () => {
		it('should fetch project fields', async () => {
			const fieldsData = {
				fields: [
					{
						id: 'field-1',
						name: 'Status',
						dataType: 'SINGLE_SELECT',
						options: [
							{ id: 'option-1', name: 'Todo' },
							{ id: 'option-2', name: 'In Progress' },
							{ id: 'option-3', name: 'Done' },
						],
					},
				],
			}

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(fieldsData),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await fetchProjectFields(1, 'testowner')

			expect(result).toEqual(fieldsData)
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'project',
					'field-list',
					'1',
					'--owner',
					'testowner',
					'--format',
					'json',
				],
				expect.any(Object)
			)
		})
	})

	describe('updateProjectItemField', () => {
		it('should update project item field', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify({ success: true }),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			await updateProjectItemField(
				'item-1',
				'proj-1',
				'field-1',
				'opt-1'
			)

			// Should complete without throwing
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'project',
					'item-edit',
					'--id',
					'item-1',
					'--project-id',
					'proj-1',
					'--field-id',
					'field-1',
					'--single-select-option-id',
					'opt-1',
					'--format',
					'json',
				],
				expect.any(Object)
			)
		})
	})

	describe('error handling', () => {
		it('should throw on command failure', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'Could not resolve to an Issue',
				message: 'Command failed',
				exitCode: 1,
			})

			await expect(executeGhCommand(['issue', 'view', '999'])).rejects.toThrow('Command failed')
		})

		it('should throw on authentication error', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'HTTP 401: authentication required',
				message: 'Authentication required',
				exitCode: 1,
			})

			await expect(executeGhCommand(['issue', 'list'])).rejects.toThrow('Authentication required')
		})

		it('should throw on rate limit error', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'rate limit exceeded',
				message: 'Rate limit exceeded',
				exitCode: 1,
			})

			await expect(executeGhCommand(['issue', 'list'])).rejects.toThrow('Rate limit exceeded')
		})

		it('should throw on missing scope error', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'missing required scope',
				message: 'Missing required scope',
				exitCode: 1,
			})

			await expect(executeGhCommand(['project', 'list'])).rejects.toThrow('Missing required scope')
		})

		it('should throw for unknown errors', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'Unknown error occurred',
				message: 'Unknown error',
				exitCode: 1,
			})

			await expect(executeGhCommand(['issue', 'list'])).rejects.toThrow('Unknown error')
		})
	})

	describe('GitHub Issue Creation', () => {
		it('should create GitHub issue with title and body', async () => {
			const issueUrl = 'https://github.com/owner/repo/issues/123'

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: issueUrl,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await createIssue('Test issue title', 'Test issue body')

			expect(result).toEqual({
				number: 123,
				url: issueUrl
			})
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'issue',
					'create',
					'--title',
					'Test issue title',
					'--body',
					'Test issue body'
				],
				expect.any(Object)
			)
		})

		it('should create GitHub issue with labels', async () => {
			const issueUrl = 'https://github.com/owner/repo/issues/124'

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: issueUrl,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await createIssue('Test', 'Body', { labels: ['bug', 'enhancement'] })

			expect(result).toEqual({
				number: 124,
				url: issueUrl
			})
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'issue',
					'create',
					'--title',
					'Test',
					'--body',
					'Body',
					'--label',
					'bug,enhancement'
				],
				expect.any(Object)
			)
		})

		it('should create GitHub issue in specific repository', async () => {
			const issueUrl = 'https://github.com/other-owner/other-repo/issues/125'

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: issueUrl,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await createIssue('Test', 'Body', { repo: 'other-owner/other-repo' })

			expect(result).toEqual({
				number: 125,
				url: issueUrl
			})
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'issue',
					'create',
					'--repo',
					'other-owner/other-repo',
					'--title',
					'Test',
					'--body',
					'Body'
				],
				expect.objectContaining({
					timeout: 30000,
					encoding: 'utf8'
				})
			)
		})

		it('should create GitHub issue with both repo and labels', async () => {
			const issueUrl = 'https://github.com/other-owner/other-repo/issues/126'

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: issueUrl,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await createIssue('Test', 'Body', {
				repo: 'other-owner/other-repo',
				labels: ['bug']
			})

			expect(result).toEqual({
				number: 126,
				url: issueUrl
			})
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'issue',
					'create',
					'--repo',
					'other-owner/other-repo',
					'--title',
					'Test',
					'--body',
					'Body',
					'--label',
					'bug'
				],
				expect.any(Object)
			)
		})

		it('should handle multiline issue body', async () => {
			const issueUrl = 'https://github.com/owner/repo/issues/456'

			const multilineBody = `## Summary
This is a detailed description
with multiple lines.

- Bullet point 1
- Bullet point 2`

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: issueUrl,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await createIssue('Multi-line test', multilineBody)

			expect(result).toEqual({
				number: 456,
				url: issueUrl
			})
			expect(execa).toHaveBeenCalledWith(
				'gh',
				expect.arrayContaining([
					'--body',
					multilineBody
				]),
				expect.any(Object)
			)
		})

		it('should parse issue URL with trailing whitespace', async () => {
			const issueUrl = 'https://github.com/owner/repo/issues/789'

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: `${issueUrl}\n`,
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await createIssue('Test', 'Body')

			expect(result).toEqual({
				number: 789,
				url: issueUrl
			})
		})

		it('should handle issue creation errors', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'API error',
				message: 'Failed to create issue',
				exitCode: 1,
			})

			await expect(createIssue('Test', 'Body')).rejects.toThrow('Failed to create issue')
		})

		it('should throw error if URL cannot be parsed', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'Invalid output without URL',
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			await expect(createIssue('Test', 'Body')).rejects.toThrow('Failed to parse issue URL from gh output')
		})
	})

	describe('GitHub Comment Operations', () => {
		it('should create issue comment via gh api', async () => {
			const commentData = {
				id: 12345,
				url: 'https://github.com/owner/repo/issues/123#issuecomment-12345',
				created_at: '2025-10-17T12:00:00Z'
			}

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(commentData),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await createIssueComment(123, 'Test comment body')

			expect(result).toEqual(commentData)
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'api',
					'repos/:owner/:repo/issues/123/comments',
					'-f',
					'body=Test comment body',
					'--jq',
					'{id: .id, url: .html_url, created_at: .created_at}'
				],
				expect.any(Object)
			)
		})

		it('should update issue comment via gh api', async () => {
			const commentData = {
				id: 12345,
				url: 'https://github.com/owner/repo/issues/123#issuecomment-12345',
				updated_at: '2025-10-17T13:00:00Z'
			}

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(commentData),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await updateIssueComment(12345, 'Updated comment body')

			expect(result).toEqual(commentData)
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'api',
					'repos/:owner/:repo/issues/comments/12345',
					'-X',
					'PATCH',
					'-f',
					'body=Updated comment body',
					'--jq',
					'{id: .id, url: .html_url, updated_at: .updated_at}'
				],
				expect.any(Object)
			)
		})

		it('should create PR comment via gh api (uses issues endpoint)', async () => {
			const commentData = {
				id: 67890,
				url: 'https://github.com/owner/repo/pull/456#issuecomment-67890',
				created_at: '2025-10-17T14:00:00Z'
			}

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(commentData),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await createPRComment(456, 'PR comment body')

			expect(result).toEqual(commentData)
			// Verify it uses the issues endpoint, not a separate PR endpoint
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'api',
					'repos/:owner/:repo/issues/456/comments',
					'-f',
					'body=PR comment body',
					'--jq',
					'{id: .id, url: .html_url, created_at: .created_at}'
				],
				expect.any(Object)
			)
		})

		it('should get repository owner and name', async () => {
			const repoData = {
				owner: { login: 'testowner' },
				name: 'testrepo'
			}

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(repoData),
				stderr: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await getRepoInfo()

			expect(result).toEqual({
				owner: 'testowner',
				name: 'testrepo'
			})
			expect(execa).toHaveBeenCalledWith(
				'gh',
				[
					'repo',
					'view',
					'--json',
					'owner,name'
				],
				expect.any(Object)
			)
		})

		it('should handle comment creation errors', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'API rate limit exceeded',
				message: 'Failed to create comment',
				exitCode: 1,
			})

			await expect(createIssueComment(123, 'Test')).rejects.toThrow('Failed to create comment')
		})

		it('should handle comment update errors', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'Comment not found',
				message: 'Failed to update comment',
				exitCode: 1,
			})

			await expect(updateIssueComment(99999, 'Test')).rejects.toThrow('Failed to update comment')
		})
	})
})
