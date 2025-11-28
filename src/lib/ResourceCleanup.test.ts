import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ResourceCleanup } from './ResourceCleanup.js'
import { GitWorktreeManager } from './GitWorktreeManager.js'
import { DatabaseManager } from './DatabaseManager.js'
import { ProcessManager } from './process/ProcessManager.js'
import { SettingsManager } from './SettingsManager.js'
import type { GitWorktree } from '../types/worktree.js'
import type { ResourceCleanupOptions } from '../types/cleanup.js'
import { executeGitCommand, findMainWorktreePathWithSettings, hasUncommittedChanges } from '../utils/git.js'
import { logger } from '../utils/logger.js'

// Mock dependencies
vi.mock('./GitWorktreeManager.js')
vi.mock('./DatabaseManager.js')
vi.mock('./process/ProcessManager.js')
vi.mock('./SettingsManager.js')
vi.mock('../utils/git.js')

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

			// Mock branch deletion
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValueOnce('/path/to/main')
			vi.mocked(executeGitCommand).mockResolvedValueOnce('')

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
			expect(result.operations).toHaveLength(4) // dev-server, worktree, branch, database
			expect(result.operations[0]?.type).toBe('dev-server')
			expect(result.operations[0]?.success).toBe(true)
			expect(result.operations[1]?.type).toBe('worktree')
			expect(result.operations[2]?.type).toBe('branch')
			expect(result.operations[3]?.type).toBe('database')
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

			expect(result.operations).toHaveLength(2) // dev-server check + worktree removal
			expect(result.operations.every(op => 'type' in op)).toBe(true)
			expect(result.operations.every(op => 'success' in op)).toBe(true)
			expect(result.operations.every(op => 'message' in op)).toBe(true)
		})

		it('should support dry-run mode without executing changes', async () => {
			vi.mocked(mockGitWorktree.findWorktreeForIssue).mockResolvedValueOnce(mockWorktree)
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
			vi.mocked(executeGitCommand).mockResolvedValueOnce('')

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
			vi.mocked(executeGitCommand).mockResolvedValueOnce('')

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
			vi.mocked(executeGitCommand).mockRejectedValueOnce(new Error('branch not fully merged'))

			await expect(resourceCleanup.deleteBranch('feat/unmerged-branch')).rejects.toThrow(
				/Cannot delete unmerged branch.*Use --force/
			)
		})

		it('should support dry-run mode', async () => {

			const result = await resourceCleanup.deleteBranch('feat/test-branch', { dryRun: true })

			expect(result).toBe(true)
			expect(executeGitCommand).not.toHaveBeenCalled()
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

			const result = await cleanupWithoutDB.cleanupDatabase('feat/issue-25')

			expect(result).toBe(false)
		})

		it('should handle database cleanup when DatabaseManager is available', async () => {
			// Currently returns false as DatabaseManager is not implemented
			const result = await resourceCleanup.cleanupDatabase('feat/issue-25')

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
})
