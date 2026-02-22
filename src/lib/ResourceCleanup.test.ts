import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ResourceCleanup } from './ResourceCleanup.js'
import { GitWorktreeManager } from './GitWorktreeManager.js'
import { DatabaseManager } from './DatabaseManager.js'
import { ProcessManager } from './process/ProcessManager.js'
import { SettingsManager } from './SettingsManager.js'
import type { GitWorktree } from '../types/worktree.js'
import type { ResourceCleanupOptions } from '../types/cleanup.js'
import { executeGitCommand, findMainWorktreePathWithSettings, hasUncommittedChanges, isBranchMergedIntoMain, checkRemoteBranchStatus, getMergeTargetBranch, findWorktreeForBranch } from '../utils/git.js'
import { logger } from '../utils/logger.js'

// Mock dependencies
vi.mock('./GitWorktreeManager.js')
vi.mock('./DatabaseManager.js')
vi.mock('./process/ProcessManager.js')
vi.mock('./SettingsManager.js')

// Mock MetadataManager to prevent real file creation during tests
vi.mock('./MetadataManager.js', () => ({
	MetadataManager: vi.fn(() => ({
		writeMetadata: vi.fn().mockResolvedValue(undefined),
		readMetadata: vi.fn().mockResolvedValue(null),
		deleteMetadata: vi.fn().mockResolvedValue(undefined),
		archiveMetadata: vi.fn().mockResolvedValue(undefined),
		slugifyPath: vi.fn((path: string) => path.replace(/\//g, '___') + '.json'),
	})),
}))
vi.mock('../utils/git.js', () => ({
	executeGitCommand: vi.fn(),
	hasUncommittedChanges: vi.fn(),
	findMainWorktreePathWithSettings: vi.fn(),
	isBranchMergedIntoMain: vi.fn(),
	checkRemoteBranchStatus: vi.fn(),
	getMergeTargetBranch: vi.fn().mockResolvedValue('main'),
	findWorktreeForBranch: vi.fn(),
	extractIssueNumber: vi.fn((branch: string) => {
		// Priority 1: New format - issue-{issueId}__
		const newMatch = branch.match(/issue-([^_]+)__/i)
		if (newMatch?.[1]) return newMatch[1]

		// Priority 2: Old format - issue-{number}- or issue-{number}$
		const oldMatch = branch.match(/issue-(\d+)(?:-|$)/i)
		if (oldMatch?.[1]) return oldMatch[1]

		// Priority 3: Legacy patterns
		const legacyMatch = branch.match(/issue_(\d+)|^(\d+)-/i)
		if (legacyMatch?.[1] || legacyMatch?.[2]) return legacyMatch[1] || legacyMatch[2]

		return null
	}),
}))

describe('ResourceCleanup', () => {
	let resourceCleanup: ResourceCleanup
	let mockGitWorktree: GitWorktreeManager
	let mockProcessManager: ProcessManager
	let mockDatabase: DatabaseManager
	let mockSettingsManager: SettingsManager

	beforeEach(() => {
		// Create mock instances
		mockGitWorktree = new GitWorktreeManager()
		mockProcessManager = new ProcessManager()
		mockDatabase = new DatabaseManager()
		mockSettingsManager = {
			loadSettings: vi.fn().mockResolvedValue({}),
			getProtectedBranches: vi.fn().mockResolvedValue(['main', 'main', 'master', 'develop']),
		} as unknown as SettingsManager

		// Initialize ResourceCleanup with mocks
		resourceCleanup = new ResourceCleanup(
			mockGitWorktree,
			mockProcessManager,
			mockDatabase,
			undefined,
			mockSettingsManager
		)

		// Add missing mock methods for GitWorktreeManager
		mockGitWorktree.findWorktreeForIssue = vi.fn()
		mockGitWorktree.findWorktreeForPR = vi.fn()
		mockGitWorktree.findWorktreeForBranch = vi.fn()
		mockGitWorktree.isMainWorktree = vi.fn()

		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('cleanupWorktree', () => {
		const mockWorktree: GitWorktree = {
			path: '/path/to/worktree',
			branch: 'feat/issue-25',
			commit: 'abc123',
			bare: false,
			detached: false,
			locked: false,
		}

		it('should successfully cleanup complete worktree (dev server + worktree + branch + database)', async () => {
			// Mock specific worktree finding method for issue type
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)

			// Mock safety checks - remote exists and local is up-to-date (scenario 3: safe)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: true,
				remoteAhead: false,
				localAhead: false,
				networkError: false
			})

			// Mock process detection (dev server found)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce({
				pid: 12345,
				name: 'node',
				command: 'node next dev',
				port: 3025,
				isDevServer: true,
			})
			vi.mocked(mockProcessManager.terminateProcess).mockResolvedValueOnce(true)
			vi.mocked(mockProcessManager.verifyPortFree).mockResolvedValueOnce(true)

			// Mock worktree removal
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)

			// Mock branch deletion pre-fetch and execution
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			// getMergeTargetBranch is called in Step 3.6 (pre-fetch) - returns 'main' from global mock
			vi.mocked(findWorktreeForBranch).mockResolvedValueOnce('/path/to/main-worktree')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			// Mock database cleanup (not implemented yet, should skip)
			// No mock needed as it's optional

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {
				deleteBranch: true,
				keepDatabase: false,
			} as ResourceCleanupOptions)

			expect(result.success).toBe(true)
			expect(result.errors).toHaveLength(0)
			expect(result.operations).toHaveLength(6) // dev-server, worktree, recap, branch, database, metadata
			expect(result.operations[0]?.type).toBe('dev-server')
			expect(result.operations[0]?.success).toBe(true)
			expect(result.operations[1]?.type).toBe('worktree')
			expect(result.operations[2]?.type).toBe('recap')
			expect(result.operations[3]?.type).toBe('branch')
			expect(result.operations[4]?.type).toBe('database')
			expect(result.operations[5]?.type).toBe('metadata')
		})

		it('should pre-fetch merge target BEFORE worktree deletion (bug fix for issue #328)', async () => {
			// This test verifies the critical bug fix: merge target must be fetched
			// BEFORE the worktree is deleted, because after deletion the metadata
			// file won't be readable.
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)

			// Mock safety checks
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: true,
				remoteAhead: false,
				localAhead: false,
				networkError: false
			})

			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')

			// Mock getMergeTargetBranch to return parent branch (simulating child loom)
			vi.mocked(getMergeTargetBranch).mockResolvedValueOnce('issue-100__parent-feature')
			// Mock findWorktreeForBranch to find where parent is checked out
			vi.mocked(findWorktreeForBranch).mockResolvedValueOnce('/path/to/parent-worktree')

			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			await resourceCleanup.cleanupWorktree(parsedInput, {
				deleteBranch: true,
				keepDatabase: true,
			})

			// Key assertion: getMergeTargetBranch should be called with the worktree path
			// (which still exists at the time of the call, before Step 4 worktree deletion)
			expect(getMergeTargetBranch).toHaveBeenCalledWith(
				'/path/to/worktree',
				expect.objectContaining({
					settingsManager: mockSettingsManager,
				})
			)

			// Verify the call order: getMergeTargetBranch should be called before removeWorktree
			const getMergeTargetBranchCallOrder = vi.mocked(getMergeTargetBranch).mock.invocationCallOrder[0]
			const removeWorktreeCallOrder = vi.mocked(mockGitWorktree.removeWorktree).mock.invocationCallOrder[0]
			expect(getMergeTargetBranchCallOrder).toBeLessThan(removeWorktreeCallOrder!)
		})

		it('should handle missing dev server gracefully', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {
				keepDatabase: true,
			})

			expect(result.success).toBe(true)
			expect(result.operations[0]?.message).toContain('No dev server running')
		})

		it('should handle missing worktree gracefully', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(null)

			const parsedInput = {
				type: 'issue' as const,
				number: 99,
				originalInput: 'issue-99'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {})

			expect(result.success).toBe(false)
			expect(result.errors.length).toBeGreaterThan(0)
			expect(result.errors[0]?.message).toContain('No worktree found')
		})

		it('should handle missing database provider gracefully', async () => {
			// Create ResourceCleanup without database manager
			const cleanupWithoutDB = new ResourceCleanup(mockGitWorktree, mockProcessManager)

			// Setup mocks for the new instance
			mockGitWorktree.findWorktreeForIssue = vi.fn().mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await cleanupWithoutDB.cleanupWorktree(parsedInput, {
				keepDatabase: false,
			})

			expect(result.success).toBe(true)
			// Should skip database cleanup with warning
			const dbOperation = result.operations.find(op => op.type === 'database')
			expect(dbOperation?.message).toContain('skipped')
		})

		it('should continue cleanup on partial failures', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			// Dev server termination fails
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce({
				pid: 12345,
				name: 'node',
				command: 'node next dev',
				port: 3025,
				isDevServer: true,
			})
			vi.mocked(mockProcessManager.terminateProcess).mockRejectedValueOnce(
				new Error('Permission denied')
			)

			// But worktree removal succeeds
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {
				keepDatabase: true,
			})

			// Should continue despite dev server failure
			expect(result.errors.length).toBeGreaterThan(0)
			expect(result.operations.some(op => op.type === 'dev-server' && !op.success)).toBe(true)
			expect(result.operations.some(op => op.type === 'worktree' && op.success)).toBe(true)
		})

		it('should report all operations in CleanupResult', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {
				deleteBranch: false,
				keepDatabase: true,
			})

			expect(result.operations).toHaveLength(4) // dev-server check + worktree removal + recap archival + metadata
			expect(result.operations.every(op => 'type' in op)).toBe(true)
			expect(result.operations.every(op => 'success' in op)).toBe(true)
			expect(result.operations.every(op => 'message' in op)).toBe(true)
		})

		it('should archive metadata instead of deleting when archive option is set', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {
				keepDatabase: true,
				archive: true,
			})

			expect(result.success).toBe(true)
			const metadataOp = result.operations.find(op => op.type === 'metadata')
			expect(metadataOp?.success).toBe(true)
			expect(metadataOp?.message).toBe('Metadata archived')
		})

		it('should delete metadata when archive option is not set', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {
				keepDatabase: true,
				archive: false,
			})

			expect(result.success).toBe(true)
			const metadataOp = result.operations.find(op => op.type === 'metadata')
			expect(metadataOp?.success).toBe(true)
			expect(metadataOp?.message).toBe('Metadata deleted')
		})

		it('should show archive in dry-run message when archive option is set', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: true,
				remoteAhead: false,
				localAhead: false,
				networkError: false
			})
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {
				dryRun: true,
				deleteBranch: true,
				keepDatabase: false,
				archive: true,
			})

			expect(result.success).toBe(true)
			const metadataOp = result.operations.find(op => op.type === 'metadata')
			expect(metadataOp?.message).toContain('[DRY RUN]')
			expect(metadataOp?.message).toContain('archive')
		})

		it('should support dry-run mode without executing changes', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: true,
				remoteAhead: false,
				localAhead: false,
				networkError: false
			})
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {
				dryRun: true,
				deleteBranch: true,
				keepDatabase: false,
			})

			expect(result.success).toBe(true)
			expect(result.operations.every(op => op.message.includes('[DRY RUN]'))).toBe(true)

			// Verify no actual operations were performed
			expect(mockProcessManager.detectDevServer).not.toHaveBeenCalled()
			expect(mockGitWorktree.removeWorktree).not.toHaveBeenCalled()
		})

		it('should log debug information about worktree discovery', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)

			// Mock logger.debug to capture debug logs
			const debugSpy = vi.spyOn(logger, 'debug')

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			await resourceCleanup.cleanupWorktree(parsedInput, {
				keepDatabase: true,
			})

			// Verify debug information was logged (updated expected calls based on new implementation)
			expect(debugSpy).toHaveBeenCalledWith('Found worktree: path="/path/to/worktree", branch="feat/issue-25"')
		})
	})

	describe('terminateDevServer', () => {
		it('should detect and terminate running dev server', async () => {
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce({
				pid: 12345,
				name: 'node',
				command: 'node next dev',
				port: 3025,
				isDevServer: true,
			})
			vi.mocked(mockProcessManager.terminateProcess).mockResolvedValueOnce(true)
			vi.mocked(mockProcessManager.verifyPortFree).mockResolvedValueOnce(true)

			const result = await resourceCleanup.terminateDevServer(3025)

			expect(result).toBe(true)
			expect(mockProcessManager.terminateProcess).toHaveBeenCalledWith(12345)
			expect(mockProcessManager.verifyPortFree).toHaveBeenCalledWith(3025)
		})

		it('should return false when no dev server is running', async () => {
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)

			const result = await resourceCleanup.terminateDevServer(3030)

			expect(result).toBe(false)
			expect(mockProcessManager.terminateProcess).not.toHaveBeenCalled()
		})

		it('should not terminate non-dev-server processes', async () => {
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce({
				pid: 99999,
				name: 'postgres',
				command: 'postgres: iloom iloom [local] idle',
				port: 5432,
				isDevServer: false,
			})

			const result = await resourceCleanup.terminateDevServer(5432)

			expect(result).toBe(false)
			expect(mockProcessManager.terminateProcess).not.toHaveBeenCalled()
		})

		it('should verify termination after kill', async () => {
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce({
				pid: 12345,
				name: 'node',
				command: 'node next dev',
				port: 3025,
				isDevServer: true,
			})
			vi.mocked(mockProcessManager.terminateProcess).mockResolvedValueOnce(true)
			vi.mocked(mockProcessManager.verifyPortFree).mockResolvedValueOnce(true)

			await resourceCleanup.terminateDevServer(3025)

			expect(mockProcessManager.verifyPortFree).toHaveBeenCalledWith(3025)
		})

		it('should throw error when termination verification fails', async () => {
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce({
				pid: 12345,
				name: 'node',
				command: 'node next dev',
				port: 3025,
				isDevServer: true,
			})
			vi.mocked(mockProcessManager.terminateProcess).mockResolvedValueOnce(true)
			vi.mocked(mockProcessManager.verifyPortFree).mockResolvedValueOnce(false)

			await expect(resourceCleanup.terminateDevServer(3025)).rejects.toThrow(
				/may still be running/
			)
		})
	})

	describe('deleteBranch', () => {
		it('should delete local branch using git command', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			const result = await resourceCleanup.deleteBranch('feat/test-branch', {
				force: false,
			})

			expect(result).toBe(true)
			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-d', 'feat/test-branch'],
				{ cwd: '/path/to/main' }
			)
		})

		it('should protect main/master/develop branches from deletion', async () => {
			await expect(resourceCleanup.deleteBranch('main')).rejects.toThrow(/Cannot delete protected/)
			await expect(resourceCleanup.deleteBranch('master')).rejects.toThrow(
				/Cannot delete protected/
			)
			await expect(resourceCleanup.deleteBranch('develop')).rejects.toThrow(
				/Cannot delete protected/
			)
		})

		it('should use safe delete (-d) by default', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			await resourceCleanup.deleteBranch('feat/test-branch')

			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-d', 'feat/test-branch'],
				{ cwd: '/path/to/main' }
			)
		})

		it('should use force delete (-D) when force option enabled', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand).mockResolvedValueOnce('')

			await resourceCleanup.deleteBranch('feat/test-branch', { force: true })

			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-D', 'feat/test-branch'],
				{ cwd: '/path/to/main' }
			)
		})

		it('should provide helpful error message for unmerged branches', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockRejectedValueOnce(new Error('branch not fully merged')) // branch -d fails

			await expect(resourceCleanup.deleteBranch('feat/unmerged-branch')).rejects.toThrow(
				/Cannot delete unmerged branch.*Use --force/
			)
		})

		it('should use force delete (-D) when safetyVerified is true and branch is not fully merged', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockRejectedValueOnce(new Error('branch not fully merged')) // branch -d fails
				.mockResolvedValueOnce('') // branch -D succeeds

			const result = await resourceCleanup.deleteBranch('feat/unmerged-branch', {
				safetyVerified: true,
			})

			expect(result).toBe(true)
			// Verify: first attempt was -d, then retry with -D
			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-d', 'feat/unmerged-branch'],
				{ cwd: '/path/to/main' }
			)
			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-D', 'feat/unmerged-branch'],
				{ cwd: '/path/to/main' }
			)
		})

		it('should still throw for unmerged branch when safetyVerified is NOT set', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockRejectedValueOnce(new Error('branch not fully merged')) // branch -d fails

			await expect(
				resourceCleanup.deleteBranch('feat/unmerged-branch', {})
			).rejects.toThrow(/Cannot delete unmerged branch/)
		})

		it('should support dry-run mode', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			// Mock branch existence check succeeds
			vi.mocked(executeGitCommand).mockResolvedValueOnce('abc123')

			const result = await resourceCleanup.deleteBranch('feat/test-branch', { dryRun: true })

			expect(result).toBe(true)
			// Branch existence check is called, but not branch deletion
			expect(executeGitCommand).toHaveBeenCalledTimes(1)
			expect(executeGitCommand).toHaveBeenCalledWith(
				['rev-parse', '--verify', 'refs/heads/feat/test-branch'],
				{ cwd: '/path/to/main' }
			)
		})

		it('should succeed silently when branch does not exist (pre-check)', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			// Mock branch existence check fails (branch not found)
			vi.mocked(executeGitCommand).mockRejectedValueOnce(
				new Error('fatal: Needed a single revision')
			)

			const result = await resourceCleanup.deleteBranch('non-existent-branch')

			expect(result).toBe(true)
			// git branch -d should NOT be called since branch doesn't exist
			expect(executeGitCommand).toHaveBeenCalledTimes(1)
			expect(executeGitCommand).toHaveBeenCalledWith(
				['rev-parse', '--verify', 'refs/heads/non-existent-branch'],
				{ cwd: '/path/to/main' }
			)
		})

		it('should handle "branch not found" error from git branch -d gracefully', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			// Mock branch existence check passes
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // rev-parse succeeds
				.mockRejectedValueOnce(new Error("error: branch 'test' not found")) // branch -d fails

			const result = await resourceCleanup.deleteBranch('test')

			expect(result).toBe(true)
		})

		it('should handle "does not exist" error from git branch -d gracefully', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			// Mock branch existence check passes
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // rev-parse succeeds
				.mockRejectedValueOnce(new Error('error: branch does not exist')) // branch -d fails

			const result = await resourceCleanup.deleteBranch('test')

			expect(result).toBe(true)
		})

		it('should run git branch -d from parent worktree when mergeTargetBranch is provided (child looms)', async () => {
			// This test verifies the safer approach for issue #328:
			// Instead of using -D (force delete), we find the worktree where the parent branch
			// is checked out and run git branch -d from there. This lets git do its own
			// safety verification naturally.
			// The mergeTargetBranch is pre-fetched BEFORE worktree deletion (Step 3.6 in cleanupWorktree).
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			// Mock findWorktreeForBranch to return the parent worktree path
			vi.mocked(findWorktreeForBranch).mockResolvedValueOnce('/path/to/parent-worktree')

			const result = await resourceCleanup.deleteBranch('issue-101__child-feature', {
				// mergeTargetBranch is pre-fetched before worktree deletion
				mergeTargetBranch: 'issue-100__parent-feature'
			})

			expect(result).toBe(true)
			// Verify getMergeTargetBranch was NOT called (we use pre-fetched value)
			expect(getMergeTargetBranch).not.toHaveBeenCalled()
			// Verify findWorktreeForBranch was called to find where parent branch is checked out
			expect(findWorktreeForBranch).toHaveBeenCalledWith(
				'issue-100__parent-feature',
				'/path/to/main'
			)
			// Verify isBranchMergedIntoMain was NOT called (we use the safer worktree approach)
			expect(isBranchMergedIntoMain).not.toHaveBeenCalled()
			// Verify safe delete (-d) was used FROM the parent worktree
			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-d', 'issue-101__child-feature'],
				{ cwd: '/path/to/parent-worktree' }
			)
		})

		it('should use safe delete (-d) when branch is NOT merged into parent branch', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockRejectedValueOnce(new Error('branch not fully merged')) // branch deletion fails

			// Mock findWorktreeForBranch to return the parent worktree path
			vi.mocked(findWorktreeForBranch).mockResolvedValueOnce('/path/to/parent-worktree')

			await expect(
				resourceCleanup.deleteBranch('issue-101__child-feature', {
					// mergeTargetBranch is pre-fetched before worktree deletion
					mergeTargetBranch: 'issue-100__parent-feature'
				})
			).rejects.toThrow(/Cannot delete unmerged branch/)

			// Verify getMergeTargetBranch was NOT called (we use pre-fetched value)
			expect(getMergeTargetBranch).not.toHaveBeenCalled()
			// Verify safe delete (-d) was used from parent worktree
			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-d', 'issue-101__child-feature'],
				{ cwd: '/path/to/parent-worktree' }
			)
		})

		it('should fall back to force delete (-D) when parent worktree not found but branch is merged', async () => {
			// This test verifies the fallback behavior when findWorktreeForBranch fails
			// (e.g., parent worktree doesn't exist). In this case, we fall back to
			// checking merge status and using -D if merged.
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			// Mock findWorktreeForBranch to throw (parent worktree doesn't exist)
			vi.mocked(findWorktreeForBranch).mockRejectedValueOnce(
				new Error("No worktree found with branch 'issue-100__parent-feature' checked out")
			)

			// Mock isBranchMergedIntoMain to return true (branch is merged into parent)
			vi.mocked(isBranchMergedIntoMain).mockResolvedValueOnce(true)

			const result = await resourceCleanup.deleteBranch('issue-101__child-feature', {
				// mergeTargetBranch is pre-fetched before worktree deletion
				mergeTargetBranch: 'issue-100__parent-feature'
			})

			expect(result).toBe(true)
			// Verify getMergeTargetBranch was NOT called (we use pre-fetched value)
			expect(getMergeTargetBranch).not.toHaveBeenCalled()
			// Verify isBranchMergedIntoMain WAS called as fallback
			expect(isBranchMergedIntoMain).toHaveBeenCalledWith(
				'issue-101__child-feature',
				'issue-100__parent-feature',
				'/path/to/main'
			)
			// Verify force delete (-D) was used (fallback behavior)
			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-D', 'issue-101__child-feature'],
				{ cwd: '/path/to/main' }
			)
		})

		it('should use safe delete (-d) when no mergeTargetBranch is provided', async () => {
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			const result = await resourceCleanup.deleteBranch('feat/test-branch', {})

			expect(result).toBe(true)
			// Verify getMergeTargetBranch was NOT called (no mergeTargetBranch provided)
			expect(getMergeTargetBranch).not.toHaveBeenCalled()
			// Verify findWorktreeForBranch was NOT called (no mergeTargetBranch)
			expect(findWorktreeForBranch).not.toHaveBeenCalled()
			// Verify safe delete (-d) was used
			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-d', 'feat/test-branch'],
				{ cwd: '/path/to/main' }
			)
		})
	})

	describe('deleteBranch - custom protected branches', () => {
		it('should use custom protectedBranches from settings', async () => {
			// Mock settings with custom protected branches
			mockSettingsManager.loadSettings = vi.fn().mockResolvedValue({
				protectedBranches: ['develop', 'staging', 'production'],
			})
			// mainBranch defaults to 'main', so protected list is: ['main', 'develop', 'staging', 'production']
			mockSettingsManager.getProtectedBranches = vi
				.fn()
				.mockResolvedValue(['main', 'develop', 'staging', 'production'])

			// Should protect custom branches
			await expect(resourceCleanup.deleteBranch('develop')).rejects.toThrow(
				/Cannot delete protected branch/
			)
			await expect(resourceCleanup.deleteBranch('staging')).rejects.toThrow(
				/Cannot delete protected branch/
			)
			await expect(resourceCleanup.deleteBranch('production')).rejects.toThrow(
				/Cannot delete protected branch/
			)
		})

		it('should always protect mainBranch even if not in protectedBranches setting', async () => {

			// Mock settings with mainBranch: 'trunk', protectedBranches: ['staging']
			mockSettingsManager.loadSettings = vi.fn().mockResolvedValue({
				mainBranch: 'trunk',
				protectedBranches: ['staging'],
			})
			// getProtectedBranches should prepend 'trunk' to ['staging']
			mockSettingsManager.getProtectedBranches = vi.fn().mockResolvedValue(['trunk', 'staging'])

			// Verify 'trunk' is protected even though not in protectedBranches array
			await expect(resourceCleanup.deleteBranch('trunk')).rejects.toThrow(
				/Cannot delete protected branch/
			)

			// Verify 'staging' is also protected
			await expect(resourceCleanup.deleteBranch('staging')).rejects.toThrow(
				/Cannot delete protected branch/
			)

			// Verify non-protected branches can be deleted
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand).mockResolvedValueOnce('')

			const result = await resourceCleanup.deleteBranch('feature-123', { force: false })
			expect(result).toBe(true)
		})

		it('should use default protected branches when not configured', async () => {

			// Mock settings without protectedBranches
			mockSettingsManager.loadSettings = vi.fn().mockResolvedValue({})
			// getProtectedBranches returns defaults: ['main', 'main', 'master', 'develop']
			mockSettingsManager.getProtectedBranches = vi
				.fn()
				.mockResolvedValue(['main', 'main', 'master', 'develop'])

			// Verify default list is used: ['main', 'master', 'develop']
			await expect(resourceCleanup.deleteBranch('main')).rejects.toThrow(
				/Cannot delete protected branch/
			)
			await expect(resourceCleanup.deleteBranch('master')).rejects.toThrow(
				/Cannot delete protected branch/
			)
			await expect(resourceCleanup.deleteBranch('develop')).rejects.toThrow(
				/Cannot delete protected branch/
			)

			// Verify non-protected branches can be deleted
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand).mockResolvedValueOnce('')

			const result = await resourceCleanup.deleteBranch('feature-456', { force: false })
			expect(result).toBe(true)
		})

		it('should protect custom mainBranch by default', async () => {
			// Mock settings with mainBranch: 'production', no protectedBranches
			mockSettingsManager.loadSettings = vi.fn().mockResolvedValue({
				mainBranch: 'production',
			})
			// getProtectedBranches returns defaults with custom mainBranch
			mockSettingsManager.getProtectedBranches = vi
				.fn()
				.mockResolvedValue(['production', 'main', 'master', 'develop'])

			// Verify 'production' is protected along with defaults
			await expect(resourceCleanup.deleteBranch('production')).rejects.toThrow(
				/Cannot delete protected branch/
			)
			await expect(resourceCleanup.deleteBranch('main')).rejects.toThrow(
				/Cannot delete protected branch/
			)
			await expect(resourceCleanup.deleteBranch('master')).rejects.toThrow(
				/Cannot delete protected branch/
			)
			await expect(resourceCleanup.deleteBranch('develop')).rejects.toThrow(
				/Cannot delete protected branch/
			)
		})

		it('should include custom branch name in protected branch error messages', async () => {
			// Mock settings with mainBranch: 'production'
			mockSettingsManager.loadSettings = vi.fn().mockResolvedValue({
				mainBranch: 'production',
			})
			// getProtectedBranches returns defaults with custom mainBranch
			mockSettingsManager.getProtectedBranches = vi
				.fn()
				.mockResolvedValue(['production', 'main', 'master', 'develop'])

			// Attempt to delete 'production' and verify error message includes it
			await expect(resourceCleanup.deleteBranch('production')).rejects.toThrow('production')
		})

		it('should allow deletion of non-protected custom branches', async () => {

			// Mock settings with mainBranch: 'trunk', protectedBranches: ['trunk', 'staging']
			mockSettingsManager.loadSettings = vi.fn().mockResolvedValue({
				mainBranch: 'trunk',
				protectedBranches: ['trunk', 'staging'],
			})
			// getProtectedBranches should not duplicate 'trunk'
			mockSettingsManager.getProtectedBranches = vi.fn().mockResolvedValue(['trunk', 'staging'])

			// Verify 'feature-123' can be deleted
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand).mockResolvedValueOnce('')

			const result = await resourceCleanup.deleteBranch('feature-123', { force: false })

			expect(result).toBe(true)
			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-d', 'feature-123'],
				{ cwd: '/path/to/main' }
			)
		})

		it('should not duplicate mainBranch in protectedBranches if already present', async () => {

			// Mock settings with mainBranch already in protectedBranches
			mockSettingsManager.loadSettings = vi.fn().mockResolvedValue({
				mainBranch: 'develop',
				protectedBranches: ['develop', 'staging', 'production'],
			})
			// getProtectedBranches should not duplicate 'develop'
			mockSettingsManager.getProtectedBranches = vi
				.fn()
				.mockResolvedValue(['develop', 'staging', 'production'])

			// Verify 'develop' is protected
			await expect(resourceCleanup.deleteBranch('develop')).rejects.toThrow(
				/Cannot delete protected branch/
			)

			// The implementation should not create duplicates
			// We can't directly test the array, but we can ensure behavior is correct
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand).mockResolvedValueOnce('')

			// Non-protected branch should still work
			const result = await resourceCleanup.deleteBranch('feature-789', { force: false })
			expect(result).toBe(true)
		})
	})

	describe('cleanupDatabase', () => {
		it('should gracefully degrade when DatabaseManager is unavailable', async () => {
			const cleanupWithoutDB = new ResourceCleanup(mockGitWorktree, mockProcessManager)

			const result = await cleanupWithoutDB.cleanupDatabase('feat/issue-25', '/path/to/worktree')

			expect(result).toBe(false)
		})

		it('should handle database cleanup when DatabaseManager is available', async () => {
			// Currently returns false as DatabaseManager is not implemented
			const result = await resourceCleanup.cleanupDatabase('feat/issue-25', '/path/to/worktree')

			// Should return false since implementation is pending Issue #5
			expect(result).toBe(false)
		})
	})

	describe('cleanupMultipleWorktrees', () => {
		const mockWorktree1: GitWorktree = {
			path: '/path/to/worktree1',
			branch: 'feat/issue-1',
			commit: 'abc123',
			bare: false,
			detached: false,
			locked: false,
		}

		const mockWorktree2: GitWorktree = {
			path: '/path/to/worktree2',
			branch: 'feat/issue-2',
			commit: 'def456',
			bare: false,
			detached: false,
			locked: false,
		}

		it('should cleanup multiple worktrees sequentially', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue)
				.mockResolvedValueOnce(mockWorktree1)
				.mockResolvedValueOnce(mockWorktree2)

			vi.mocked(mockProcessManager.calculatePort)
				.mockReturnValueOnce(3001)
				.mockReturnValueOnce(3002)

			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)

			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValue(undefined)

			const results = await resourceCleanup.cleanupMultipleWorktrees(['issue-1', 'issue-2'], {
				keepDatabase: true,
			})

			expect(results).toHaveLength(2)
			expect(results[0]?.identifier).toBe('1')
			expect(results[1]?.identifier).toBe('2')
		})

		it('should continue on individual failures', async () => {
			// First worktree fails (issue-99 returns null), second succeeds
			vi.mocked(mockGitWorktree.findWorktreeForIssue)
				.mockResolvedValueOnce(null)  // First call for 'issue-99' fails
				.mockResolvedValueOnce(mockWorktree2)  // Second call for 'issue-2' succeeds

			vi.mocked(mockProcessManager.calculatePort)
				.mockReturnValueOnce(3099) // For issue-99
				.mockReturnValueOnce(3002) // For issue-2
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValue(undefined)

			const results = await resourceCleanup.cleanupMultipleWorktrees(['issue-99', 'issue-2'], {
				keepDatabase: true,
			})

			expect(results).toHaveLength(2)
			expect(results[0]?.success).toBe(false)
			expect(results[1]?.success).toBe(true)
		})

		it('should aggregate results from all cleanup operations', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue)
				.mockResolvedValueOnce(mockWorktree1)
				.mockResolvedValueOnce(mockWorktree2)

			vi.mocked(mockProcessManager.calculatePort)
				.mockReturnValueOnce(3001)
				.mockReturnValueOnce(3002)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValue(undefined)

			const results = await resourceCleanup.cleanupMultipleWorktrees(['issue-1', 'issue-2'], {
				keepDatabase: true,
			})

			expect(results.every(r => 'identifier' in r)).toBe(true)
			expect(results.every(r => 'operations' in r)).toBe(true)
			expect(results.every(r => 'errors' in r)).toBe(true)
		})
	})

	describe('validateCleanupSafety', () => {
		const mockWorktree: GitWorktree = {
			path: '/path/to/worktree',
			branch: 'feat/issue-25',
			commit: 'abc123',
			bare: false,
			detached: false,
			locked: false,
		}

		it('should check for uncommitted changes and add blocker', async () => {
			vi.mocked(mockGitWorktree.findWorktreesByIdentifier).mockResolvedValueOnce([mockWorktree])
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)

			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(true)

			const result = await resourceCleanup.validateCleanupSafety('issue-25')

			expect(result.isSafe).toBe(false)
			expect(result.blockers.length).toBeGreaterThan(0)
			expect(result.blockers[0]).toContain('Worktree has uncommitted changes')
			expect(result.blockers[0]).toContain('Please resolve before cleanup')
			expect(result.blockers[0]).toContain('Force cleanup: il cleanup issue-25 --force')
		})

		it('should block cleanup of main worktree', async () => {
			vi.mocked(mockGitWorktree.findWorktreesByIdentifier).mockResolvedValueOnce([mockWorktree])
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(true)

			const result = await resourceCleanup.validateCleanupSafety('issue-25')

			expect(result.isSafe).toBe(false)
			expect(result.blockers.length).toBe(1)
			expect(result.blockers[0]).toMatch(/Cannot cleanup main worktree/)
		})

		it('should block when worktree does not exist', async () => {
			vi.mocked(mockGitWorktree.findWorktreesByIdentifier).mockResolvedValueOnce([])

			const result = await resourceCleanup.validateCleanupSafety('issue-99')

			expect(result.isSafe).toBe(false)
			expect(result.blockers.length).toBeGreaterThan(0)
		})
	})

	describe('cleanupWorktree - 5-point safety check (Issue #275)', () => {
		const mockWorktree: GitWorktree = {
			path: '/path/to/worktree',
			branch: 'feat/issue-25',
			commit: 'abc123',
			bare: false,
			detached: false,
			locked: false,
		}

		// Scenario 1: Remote branch exists AND is ahead of local -> OK (no data loss - commits exist on remote)
		it('should allow cleanup when remote branch is ahead of local (scenario 1 - SAFE)', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: true,
				remoteAhead: true,
				localAhead: false,
				networkError: false
			})
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })

			expect(result.success).toBe(true)
		})

		// New scenario: Local is ahead of remote (unpushed commits) -> BLOCK (data loss risk)
		it('should block cleanup when local branch has unpushed commits (data loss risk)', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: true,
				remoteAhead: false,
				localAhead: true,
				networkError: false
			})
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			await expect(
				resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })
			).rejects.toThrow(/has unpushed commits/)
		})

		it('should provide helpful error message when local has unpushed commits', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: true,
				remoteAhead: false,
				localAhead: true,
				networkError: false
			})
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			try {
				await resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })
				expect.fail('Should have thrown an error')
			} catch (error) {
				const message = (error as Error).message
				expect(message).toContain('git push')
				expect(message).toContain('--force')
			}
		})

		// Scenario 2: Remote doesn't exist AND branch not merged to main -> Block
		it('should block cleanup when remote doesnt exist and branch not merged (scenario 2)', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: false,
				remoteAhead: false,
				localAhead: false,
				networkError: false
			})
			vi.mocked(isBranchMergedIntoMain).mockResolvedValueOnce(false) // NOT merged
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			await expect(
				resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })
			).rejects.toThrow(/has not been pushed to remote and is not merged/)
		})

		it('should provide helpful error message for unpushed/unmerged branch (scenario 2)', async () => {
			// Ensure getMergeTargetBranch returns 'main' for this test
			vi.mocked(getMergeTargetBranch).mockResolvedValueOnce('main')
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: false,
				remoteAhead: false,
				localAhead: false,
				networkError: false
			})
			vi.mocked(isBranchMergedIntoMain).mockResolvedValueOnce(false)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			try {
				await resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })
				expect.fail('Should have thrown an error')
			} catch (error) {
				const message = (error as Error).message
				expect(message).toContain('git push -u origin feat/issue-25')
				expect(message).toContain('git checkout main && git merge feat/issue-25')
				expect(message).toContain('--force')
			}
		})

		// Scenario 3: Remote exists, local is up-to-date (same commits) -> Fine (work is on remote)
		it('should allow cleanup when remote exists and local is up-to-date (scenario 3)', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: true,
				remoteAhead: false,
				localAhead: false, // Same commits - safe
				networkError: false
			})
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			// getMergeTargetBranch returns 'main' by default from global mock
			// findWorktreeForBranch finds the main worktree
			vi.mocked(findWorktreeForBranch).mockResolvedValueOnce('/path/to/main-worktree')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })

			expect(result.success).toBe(true)
			// With the safer approach, we run git branch -d from the target worktree
			// and let git do its own verification - no need to call isBranchMergedIntoMain
			expect(isBranchMergedIntoMain).not.toHaveBeenCalled()
		})

		// Scenario 4: Remote doesn't exist, but merged to main -> Fine
		it('should allow cleanup when remote doesnt exist but branch is merged (scenario 4)', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: false,
				remoteAhead: false,
				localAhead: false,
				networkError: false
			})
			// isBranchMergedIntoMain is called during validation when remote doesn't exist
			vi.mocked(isBranchMergedIntoMain).mockResolvedValueOnce(true) // IS merged (validation)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			// getMergeTargetBranch returns 'main' by default from global mock
			// findWorktreeForBranch finds the main worktree
			vi.mocked(findWorktreeForBranch).mockResolvedValueOnce('/path/to/main-worktree')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })

			expect(result.success).toBe(true)
		})

		// Scenario 5: Network error checking remote -> Block
		it('should block cleanup when network error occurs checking remote (scenario 5)', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: false,
				remoteAhead: false,
				localAhead: false,
				networkError: true,
				errorMessage: 'Could not resolve host: github.com'
			})
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			await expect(
				resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })
			).rejects.toThrow(/Cannot verify remote branch status due to network error/)
		})

		it('should provide helpful error message for network error (scenario 5)', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: false,
				remoteAhead: false,
				localAhead: false,
				networkError: true,
				errorMessage: 'Connection timed out'
			})
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			try {
				await resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })
				expect.fail('Should have thrown an error')
			} catch (error) {
				const message = (error as Error).message
				expect(message).toContain('Connection timed out')
				expect(message).toContain('--force')
			}
		})

		// Skip safety check when deleteBranch is false
		it('should skip safety check when deleteBranch is false', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			// Note: checkRemoteBranchStatus should NOT be called
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: false })

			expect(result.success).toBe(true)
			expect(checkRemoteBranchStatus).not.toHaveBeenCalled()
			expect(isBranchMergedIntoMain).not.toHaveBeenCalled()
		})

		// Bypass safety check when force flag is set
		it('should bypass safety check when force flag is set', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand).mockResolvedValueOnce('') // Force delete

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {
				deleteBranch: true,
				force: true
			})

			expect(result.success).toBe(true)
			expect(checkRemoteBranchStatus).not.toHaveBeenCalled()
			expect(isBranchMergedIntoMain).not.toHaveBeenCalled()
		})

		// Skip safety check when checkMergeSafety is explicitly false
		it('should skip safety check when checkMergeSafety is explicitly false', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			// getMergeTargetBranch returns 'main' by default from global mock
			// findWorktreeForBranch finds the main worktree
			vi.mocked(findWorktreeForBranch).mockResolvedValueOnce('/path/to/main-worktree')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockResolvedValueOnce('') // branch deletion

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, {
				deleteBranch: true,
				checkMergeSafety: false
			})

			expect(result.success).toBe(true)
			// Key assertion: checkRemoteBranchStatus should NOT be called (validation skipped)
			expect(checkRemoteBranchStatus).not.toHaveBeenCalled()
			// With the safer worktree approach, isBranchMergedIntoMain is not called when
			// findWorktreeForBranch succeeds
			expect(isBranchMergedIntoMain).not.toHaveBeenCalled()
		})

		// Check safety BEFORE deleting worktree
		it('should check safety BEFORE deleting worktree to prevent partial cleanup', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: false,
				remoteAhead: false,
				localAhead: false,
				networkError: false
			})
			vi.mocked(isBranchMergedIntoMain).mockResolvedValueOnce(false)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			try {
				await resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })
			} catch {
				// Expected to throw
			}

			// Assert - worktree removal should NOT have been called
			expect(mockGitWorktree.removeWorktree).not.toHaveBeenCalled()
		})

		// Use configured mainBranch from settings
		it('should use configured mainBranch from settings for merge check', async () => {
			// Mock getMergeTargetBranch to return 'develop' (simulating settings with custom mainBranch)
			vi.mocked(getMergeTargetBranch).mockResolvedValueOnce('develop')

			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: false,
				remoteAhead: false,
				localAhead: false,
				networkError: false
			})
			vi.mocked(isBranchMergedIntoMain).mockResolvedValueOnce(false)
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			try {
				await resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })
			} catch {
				// Expected to throw
			}

			// Assert - should use 'develop' as the mainBranch (via getMergeTargetBranch)
			expect(isBranchMergedIntoMain).toHaveBeenCalledWith(
				'feat/issue-25',
				'develop',
				'/path/to/worktree'
			)
		})

		it('should pass safetyVerified to deleteBranch when safety check passes, enabling force delete for unmerged branches (issue #575)', async () => {
			// This test verifies the fix for issue #575:
			// When safety check passes (remote exists, no data loss), but git branch -d
			// fails with "not fully merged" (e.g. draft PR mode), the cleanup should
			// succeed by retrying with -D since safety is already verified.
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
			vi.mocked(mockGitWorktree.isMainWorktree).mockResolvedValueOnce(false)
			vi.mocked(hasUncommittedChanges).mockResolvedValueOnce(false)
			// Safety check: remote exists, local is up-to-date (scenario 2 - safe)
			vi.mocked(checkRemoteBranchStatus).mockResolvedValueOnce({
				exists: true,
				remoteAhead: false,
				localAhead: false,
				networkError: false
			})
			vi.mocked(mockProcessManager.calculatePort).mockReturnValue(3025)
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValueOnce(null)
			vi.mocked(mockGitWorktree.removeWorktree).mockResolvedValueOnce(undefined)
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			// getMergeTargetBranch called in Step 3.6 (pre-fetch) and in safety check
			vi.mocked(getMergeTargetBranch).mockResolvedValue('main')
			// findWorktreeForBranch called in deleteBranch to find where 'main' is checked out
			vi.mocked(findWorktreeForBranch).mockResolvedValueOnce('/path/to/main-worktree')
			vi.mocked(executeGitCommand)
				.mockResolvedValueOnce('abc123') // branch existence check
				.mockRejectedValueOnce(new Error('branch not fully merged')) // -d fails
				.mockResolvedValueOnce('') // -D succeeds (safetyVerified retry)

			const parsedInput = {
				type: 'issue' as const,
				number: 25,
				originalInput: 'issue-25'
			}

			const result = await resourceCleanup.cleanupWorktree(parsedInput, { deleteBranch: true })

			expect(result.success).toBe(true)
			// Verify the branch operation succeeded
			const branchOp = result.operations.find(op => op.type === 'branch')
			expect(branchOp?.success).toBe(true)
			// Verify force delete was used as retry after -d failed with "not fully merged"
			expect(executeGitCommand).toHaveBeenCalledWith(
				['branch', '-D', 'feat/issue-25'],
				{ cwd: '/path/to/main-worktree' }
			)
		})
	})
})
