import { describe, it, expect } from 'vitest'
import { IssueTrackerFactory } from './IssueTrackerFactory.js'

describe('IssueTrackerFactory', () => {
	describe('formatIssueId', () => {
		it('should prefix GitHub identifiers with #', () => {
			expect(IssueTrackerFactory.formatIssueId('github', 123)).toBe('#123')
			expect(IssueTrackerFactory.formatIssueId('github', '456')).toBe('#456')
		})

		it('should uppercase Linear identifiers', () => {
			expect(IssueTrackerFactory.formatIssueId('linear', 'eng-123')).toBe('ENG-123')
			expect(IssueTrackerFactory.formatIssueId('linear', 'ENG-456')).toBe('ENG-456')
		})

		it('should uppercase Jira identifiers', () => {
			expect(IssueTrackerFactory.formatIssueId('jira', 'qlh-4404')).toBe('QLH-4404')
			expect(IssueTrackerFactory.formatIssueId('jira', 'PROJ-100')).toBe('PROJ-100')
		})

		it('should default to # prefix for unknown provider types', () => {
			// Cast to bypass type checking for the default case
			expect(IssueTrackerFactory.formatIssueId('unknown' as 'github', 99)).toBe('#99')
		})
	})
})
