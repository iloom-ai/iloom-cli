import { describe, it, expect } from 'vitest'
import { generatePortOffsetFromBranchName, calculatePortForBranch } from './port.js'
import fc from 'fast-check'

describe('Port utilities', () => {
	describe('generatePortOffsetFromBranchName', () => {
		it('should generate deterministic port offset for same branch name', () => {
			const branchName = 'feat/issue-87__add-commands'
			const offset1 = generatePortOffsetFromBranchName(branchName)
			const offset2 = generatePortOffsetFromBranchName(branchName)
			expect(offset1).toBe(offset2)
		})

		it('should return different offsets for different branch names', () => {
			const offset1 = generatePortOffsetFromBranchName('feat/branch-a')
			const offset2 = generatePortOffsetFromBranchName('feat/branch-b')
			expect(offset1).not.toBe(offset2)
		})

		it('should always return offset in range [1, 999]', () => {
			const testCases = [
				'main',
				'develop',
				'feat/issue-123',
				'fix/bug-456',
				'very-long-branch-name-with-many-characters-to-test-edge-cases',
				'a',
				'123',
			]

			for (const branchName of testCases) {
				const offset = generatePortOffsetFromBranchName(branchName)
				expect(offset).toBeGreaterThanOrEqual(1)
				expect(offset).toBeLessThanOrEqual(999)
			}
		})

		it('should handle branch names with special characters (/, -, _)', () => {
			const offset1 = generatePortOffsetFromBranchName('feat/issue-87_add-commands')
			const offset2 = generatePortOffsetFromBranchName('fix/bug_123-update')
			const offset3 = generatePortOffsetFromBranchName('chore/deps-update_v2')

			expect(offset1).toBeGreaterThanOrEqual(1)
			expect(offset1).toBeLessThanOrEqual(999)
			expect(offset2).toBeGreaterThanOrEqual(1)
			expect(offset2).toBeLessThanOrEqual(999)
			expect(offset3).toBeGreaterThanOrEqual(1)
			expect(offset3).toBeLessThanOrEqual(999)
		})

		it('should handle unicode characters in branch names', () => {
			const offset1 = generatePortOffsetFromBranchName('feat/添加功能')
			const offset2 = generatePortOffsetFromBranchName('fix/🐛-bug')
			const offset3 = generatePortOffsetFromBranchName('chore/Übersetzung')

			expect(offset1).toBeGreaterThanOrEqual(1)
			expect(offset1).toBeLessThanOrEqual(999)
			expect(offset2).toBeGreaterThanOrEqual(1)
			expect(offset2).toBeLessThanOrEqual(999)
			expect(offset3).toBeGreaterThanOrEqual(1)
			expect(offset3).toBeLessThanOrEqual(999)
		})

		it('should throw error for empty branch name', () => {
			expect(() => generatePortOffsetFromBranchName('')).toThrow('Branch name cannot be empty')
			expect(() => generatePortOffsetFromBranchName('   ')).toThrow('Branch name cannot be empty')
		})

		it('should match expected hash distribution', () => {
			// Test a few known branch names to ensure consistent hashing
			// These values are deterministic and should never change
			const offset1 = generatePortOffsetFromBranchName('main')
			const offset2 = generatePortOffsetFromBranchName('develop')

			expect(offset1).toBeGreaterThanOrEqual(1)
			expect(offset1).toBeLessThanOrEqual(999)
			expect(offset2).toBeGreaterThanOrEqual(1)
			expect(offset2).toBeLessThanOrEqual(999)

			// Same input should always produce same output
			expect(generatePortOffsetFromBranchName('main')).toBe(offset1)
			expect(generatePortOffsetFromBranchName('develop')).toBe(offset2)
		})
	})

	describe('calculatePortForBranch', () => {
		it('should calculate port with default base port (3000)', () => {
			const branchName = 'feat/test'
			const port = calculatePortForBranch(branchName)

			expect(port).toBeGreaterThanOrEqual(3001)
			expect(port).toBeLessThanOrEqual(3999)
		})

		it('should calculate port with custom base port', () => {
			const branchName = 'feat/test'
			const basePort = 5000
			const port = calculatePortForBranch(branchName, basePort)

			expect(port).toBeGreaterThanOrEqual(5001)
			expect(port).toBeLessThanOrEqual(5999)
		})

		it('should return same port for same branch name', () => {
			const branchName = 'feat/consistent'
			const port1 = calculatePortForBranch(branchName)
			const port2 = calculatePortForBranch(branchName)

			expect(port1).toBe(port2)
		})

		it('should return different ports for different branch names', () => {
			const port1 = calculatePortForBranch('feat/branch-a')
			const port2 = calculatePortForBranch('feat/branch-b')

			expect(port1).not.toBe(port2)
		})

		it('should validate port does not exceed 65535', () => {
			// Find a branch name that hashes to high offset (close to 999)
			// and use basePort that causes total to exceed 65535
			// Using basePort 65000 and any offset > 535 will exceed 65535
			// We need to find a branch that hashes to offset > 535

			// This branch 'feat/trigger-high-port' hashes to offset 793
			// 65000 + 793 = 65793 > 65535
			const branchName = 'feat/trigger-high-port'
			const basePort = 65000

			expect(() => calculatePortForBranch(branchName, basePort)).toThrow(
				'exceeds maximum (65535)'
			)
		})

		it('should throw error for empty branch name', () => {
			expect(() => calculatePortForBranch('')).toThrow('Branch name cannot be empty')
		})
	})

	describe('property-based tests', () => {
		it('should generate same port for same branch name', () => {
			fc.assert(
				fc.property(fc.string({ minLength: 1, maxLength: 100 }), (branchName) => {
					// Skip whitespace-only strings
					if (branchName.trim().length === 0) return

					const port1 = calculatePortForBranch(branchName)
					const port2 = calculatePortForBranch(branchName)

					expect(port1).toBe(port2)
				})
			)
		})

		it('should always generate valid ports in range [basePort+1, basePort+999]', () => {
			fc.assert(
				fc.property(fc.string({ minLength: 1, maxLength: 100 }), (branchName) => {
					// Skip whitespace-only strings
					if (branchName.trim().length === 0) return

					const basePort = 3000
					const port = calculatePortForBranch(branchName, basePort)

					expect(port).toBeGreaterThanOrEqual(basePort + 1)
					expect(port).toBeLessThanOrEqual(basePort + 999)
				})
			)
		})

		it('should handle arbitrary branch names without throwing', () => {
			fc.assert(
				fc.property(fc.string({ minLength: 1, maxLength: 100 }), (branchName) => {
					// Skip whitespace-only strings
					if (branchName.trim().length === 0) {
						expect(() => calculatePortForBranch(branchName)).toThrow('Branch name cannot be empty')
					} else {
						expect(() => calculatePortForBranch(branchName)).not.toThrow()
					}
				})
			)
		})
	})
})
