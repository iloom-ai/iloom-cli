import { describe, test, expect } from 'vitest'
import { JiraWikiSanitizer } from './jira-wiki-sanitizer.js'

describe('JiraWikiSanitizer', () => {
	describe('sanitize', () => {
		// SAFE pattern conversions (unambiguous Jira Wiki)

		test('converts h1. through h6. headings to markdown #', () => {
			expect(JiraWikiSanitizer.sanitize('h1. Main Title')).toBe('# Main Title')
			expect(JiraWikiSanitizer.sanitize('h2. Section')).toBe('## Section')
			expect(JiraWikiSanitizer.sanitize('h3. Subsection')).toBe('### Subsection')
			expect(JiraWikiSanitizer.sanitize('h4. Detail')).toBe('#### Detail')
			expect(JiraWikiSanitizer.sanitize('h5. Minor')).toBe('##### Minor')
			expect(JiraWikiSanitizer.sanitize('h6. Smallest')).toBe('###### Smallest')
		})

		test('does not convert h1. mid-sentence', () => {
			expect(JiraWikiSanitizer.sanitize('The h1. heading is used for titles')).toBe(
				'The h1. heading is used for titles'
			)
		})

		test('handles multiple headings in one body', () => {
			const input = 'h1. Title\n\nSome text\n\nh2. Section\n\nMore text'
			const expected = '# Title\n\nSome text\n\n## Section\n\nMore text'
			expect(JiraWikiSanitizer.sanitize(input)).toBe(expected)
		})

		test('converts {code}...{code} to fenced code blocks', () => {
			const input = '{code}\nconst x = 1;\nconsole.log(x);\n{code}'
			const expected = '```\nconst x = 1;\nconsole.log(x);\n```'
			expect(JiraWikiSanitizer.sanitize(input)).toBe(expected)
		})

		test('converts {code:language}...{code} to fenced code blocks with language', () => {
			const input = '{code:javascript}\nconst x = 1;\n{code}'
			const expected = '```javascript\nconst x = 1;\n```'
			expect(JiraWikiSanitizer.sanitize(input)).toBe(expected)
		})

		test('converts {quote}...{quote} to > blockquotes', () => {
			const input = '{quote}\nThis is a quote.\nWith multiple lines.\n{quote}'
			const expected = '> This is a quote.\n> With multiple lines.'
			expect(JiraWikiSanitizer.sanitize(input)).toBe(expected)
		})

		test('converts [text|url] to [text](url)', () => {
			const input = 'Check [the docs|https://example.com/docs] for more info'
			const expected = 'Check [the docs](https://example.com/docs) for more info'
			expect(JiraWikiSanitizer.sanitize(input)).toBe(expected)
		})

		test('does not convert [text|non-url] links without http', () => {
			const input = '[some text|not-a-url]'
			expect(JiraWikiSanitizer.sanitize(input)).toBe('[some text|not-a-url]')
		})

		// MUST NOT convert (ambiguous patterns)

		test('does NOT convert *text* (ambiguous bold/italic)', () => {
			const input = 'This has *italic text* in markdown'
			expect(JiraWikiSanitizer.sanitize(input)).toBe('This has *italic text* in markdown')
		})

		test('does NOT convert _text_ (ambiguous italic/snake_case)', () => {
			const input = 'This has _italic text_ in markdown'
			expect(JiraWikiSanitizer.sanitize(input)).toBe('This has _italic text_ in markdown')
		})

		test('preserves snake_case identifiers like my_variable', () => {
			const input = 'Use my_variable and another_one in your code'
			expect(JiraWikiSanitizer.sanitize(input)).toBe(
				'Use my_variable and another_one in your code'
			)
		})

		test('preserves markdown italic *like this*', () => {
			const input = 'This is *emphasized* text'
			expect(JiraWikiSanitizer.sanitize(input)).toBe('This is *emphasized* text')
		})

		// Preservation

		test('does not modify content inside backtick-fenced code blocks', () => {
			const input = '```\nh1. This is inside a code block\n{code}\nstuff\n{code}\n```'
			expect(JiraWikiSanitizer.sanitize(input)).toBe(input)
		})

		test('converts Wiki outside code blocks but preserves inside', () => {
			const input = 'h1. Title\n\n```\nh2. Not converted\n```\n\nh3. Another heading'
			const expected = '# Title\n\n```\nh2. Not converted\n```\n\n### Another heading'
			expect(JiraWikiSanitizer.sanitize(input)).toBe(expected)
		})

		test('passes through clean markdown unchanged', () => {
			const input = '# Title\n\n## Section\n\n- item 1\n- item 2\n\n```js\ncode\n```'
			expect(JiraWikiSanitizer.sanitize(input)).toBe(input)
		})

		test('handles empty string input', () => {
			expect(JiraWikiSanitizer.sanitize('')).toBe('')
		})

		test('handles undefined input gracefully', () => {
			expect(JiraWikiSanitizer.sanitize(undefined as unknown as string)).toBe('')
		})

		test('handles mixed Jira Wiki and Markdown content', () => {
			const input = [
				'h1. Implementation Plan',
				'',
				'## Already Markdown Section',
				'',
				'{code:typescript}',
				'const x = 1;',
				'{code}',
				'',
				'Check [the guide|https://example.com] for details.',
				'',
				'{quote}',
				'Important note here.',
				'{quote}',
			].join('\n')

			const expected = [
				'# Implementation Plan',
				'',
				'## Already Markdown Section',
				'',
				'```typescript',
				'const x = 1;',
				'```',
				'',
				'Check [the guide](https://example.com) for details.',
				'',
				'> Important note here.',
			].join('\n')

			expect(JiraWikiSanitizer.sanitize(input)).toBe(expected)
		})
	})

	describe('hasJiraWikiPatterns', () => {
		test('returns true when Jira Wiki headings detected', () => {
			expect(JiraWikiSanitizer.hasJiraWikiPatterns('h1. Title')).toBe(true)
			expect(JiraWikiSanitizer.hasJiraWikiPatterns('h3. Subsection')).toBe(true)
		})

		test('returns true when {code} blocks detected', () => {
			expect(JiraWikiSanitizer.hasJiraWikiPatterns('{code}\nstuff\n{code}')).toBe(true)
			expect(JiraWikiSanitizer.hasJiraWikiPatterns('{code:java}\nstuff\n{code}')).toBe(true)
		})

		test('returns true when {quote} blocks detected', () => {
			expect(JiraWikiSanitizer.hasJiraWikiPatterns('{quote}\ntext\n{quote}')).toBe(true)
		})

		test('returns true when [text|url] links detected', () => {
			expect(JiraWikiSanitizer.hasJiraWikiPatterns('[docs|https://example.com]')).toBe(true)
		})

		test('returns false for clean markdown', () => {
			expect(JiraWikiSanitizer.hasJiraWikiPatterns('# Title\n\n## Section')).toBe(false)
		})

		test('returns false for ambiguous patterns like *bold*', () => {
			expect(JiraWikiSanitizer.hasJiraWikiPatterns('This is *bold* text')).toBe(false)
		})

		test('returns false for empty string', () => {
			expect(JiraWikiSanitizer.hasJiraWikiPatterns('')).toBe(false)
		})

		test('returns false for undefined', () => {
			expect(JiraWikiSanitizer.hasJiraWikiPatterns(undefined as unknown as string)).toBe(false)
		})
	})
})
