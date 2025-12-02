import { describe, it, expect } from 'vitest'
import { slugifyTitle, buildLinearIssueUrl } from './linear.js'

describe('slugifyTitle', () => {
	it('should convert title to lowercase slug', () => {
		expect(slugifyTitle('Hello World')).toBe('hello-world')
	})

	it('should replace non-alphanumeric characters with hyphens', () => {
		expect(slugifyTitle('Fix: bug in API!')).toBe('fix-bug-in-api')
	})

	it('should remove leading and trailing hyphens', () => {
		expect(slugifyTitle('  --Hello World--  ')).toBe('hello-world')
	})

	it('should collapse multiple hyphens into one', () => {
		expect(slugifyTitle('Hello   World')).toBe('hello-world')
	})

	it('should truncate at word boundary when too long', () => {
		const longTitle = 'Create initial version of application with many features'
		const result = slugifyTitle(longTitle, 40)
		expect(result.length).toBeLessThanOrEqual(40)
		expect(result).toBe('create-initial-version-of-application')
	})

	it('should keep full slug if under max length', () => {
		const shortTitle = 'Fix bug'
		expect(slugifyTitle(shortTitle, 50)).toBe('fix-bug')
	})

	it('should handle single very long word by slicing', () => {
		const longWord = 'supercalifragilisticexpialidocious'
		const result = slugifyTitle(longWord, 20)
		expect(result.length).toBeLessThanOrEqual(20)
		expect(result).toBe('supercalifragilistic')
	})

	it('should handle empty string', () => {
		expect(slugifyTitle('')).toBe('')
	})

	it('should handle special characters', () => {
		expect(slugifyTitle('[WIP] Add feature #123')).toBe('wip-add-feature-123')
	})

	it('should use default max length of 50', () => {
		const title = 'This is a very long title that should be truncated at word boundaries to fit'
		const result = slugifyTitle(title)
		expect(result.length).toBeLessThanOrEqual(50)
	})
})

describe('buildLinearIssueUrl', () => {
	it('should build URL with identifier only', () => {
		expect(buildLinearIssueUrl('ENG-123')).toBe('https://linear.app/issue/ENG-123')
	})

	it('should build URL with identifier and title slug', () => {
		const url = buildLinearIssueUrl('ENG-123', 'Fix authentication bug')
		expect(url).toBe('https://linear.app/issue/ENG-123/fix-authentication-bug')
	})

	it('should handle long titles by truncating slug', () => {
		const url = buildLinearIssueUrl('REC-5', 'Create initial version of application with many extra features and more')
		expect(url).toContain('https://linear.app/issue/REC-5/')
		// Slug should be truncated
		const slug = url.split('/').pop()
		expect(slug?.length).toBeLessThanOrEqual(50)
	})

	it('should handle undefined title', () => {
		expect(buildLinearIssueUrl('ENG-123', undefined)).toBe('https://linear.app/issue/ENG-123')
	})

	it('should handle empty title', () => {
		expect(buildLinearIssueUrl('ENG-123', '')).toBe('https://linear.app/issue/ENG-123')
	})
})
