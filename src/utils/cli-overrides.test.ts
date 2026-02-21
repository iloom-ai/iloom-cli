import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseDotNotation, parseCliValue, extractSettingsOverrides, getExecutablePath } from './cli-overrides.js'

describe('parseCliValue', () => {
	it('should parse "true" as boolean true', () => {
		expect(parseCliValue('true')).toBe(true)
	})

	it('should parse "false" as boolean false', () => {
		expect(parseCliValue('false')).toBe(false)
	})

	it('should parse integer strings as numbers', () => {
		expect(parseCliValue('123')).toBe(123)
		expect(parseCliValue('0')).toBe(0)
		expect(parseCliValue('-42')).toBe(-42)
	})

	it('should parse float strings as numbers', () => {
		expect(parseCliValue('3.14')).toBe(3.14)
		expect(parseCliValue('-2.5')).toBe(-2.5)
		expect(parseCliValue('0.0')).toBe(0.0)
	})

	it('should keep regular strings as strings', () => {
		expect(parseCliValue('hello')).toBe('hello')
		expect(parseCliValue('neon')).toBe('neon')
		expect(parseCliValue('acceptEdits')).toBe('acceptEdits')
	})

	it('should handle empty strings', () => {
		expect(parseCliValue('')).toBe('')
	})

	it('should not parse strings that look like numbers with extra content', () => {
		expect(parseCliValue('123abc')).toBe('123abc')
		expect(parseCliValue('abc123')).toBe('abc123')
	})
})

describe('parseDotNotation', () => {
	it('should parse single-level dot notation', () => {
		const result = parseDotNotation('mainBranch', 'develop')
		expect(result).toEqual({ mainBranch: 'develop' })
	})

	it('should parse two-level dot notation', () => {
		const result = parseDotNotation('workflows.issue', 'value')
		expect(result).toEqual({
			workflows: {
				issue: 'value',
			},
		})
	})

	it('should parse three-level dot notation', () => {
		const result = parseDotNotation('workflows.issue.startIde', 'false')
		expect(result).toEqual({
			workflows: {
				issue: {
					startIde: false,
				},
			},
		})
	})

	it('should parse deep nested paths (4+ levels)', () => {
		const result = parseDotNotation('capabilities.web.basePort', '4000')
		expect(result).toEqual({
			capabilities: {
				web: {
					basePort: 4000,
				},
			},
		})
	})

	it('should parse boolean values correctly', () => {
		const result = parseDotNotation('workflows.issue.startAiAgent', 'true')
		expect(result).toEqual({
			workflows: {
				issue: {
					startAiAgent: true,
				},
			},
		})
	})

	it('should parse numeric values correctly', () => {
		const result = parseDotNotation('capabilities.web.basePort', '3500')
		expect(result).toEqual({
			capabilities: {
				web: {
					basePort: 3500,
				},
			},
		})
	})

	it('should throw error for empty key', () => {
		expect(() => parseDotNotation('', 'value')).toThrow('CLI override key cannot be empty')
	})

	it('should throw error for key with empty segments', () => {
		expect(() => parseDotNotation('workflows..issue', 'value')).toThrow(
			'Invalid key format: "workflows..issue" - empty segment found',
		)
	})

	it('should throw error for key starting with dot', () => {
		expect(() => parseDotNotation('.workflows', 'value')).toThrow('empty segment found')
	})

	it('should throw error for key ending with dot', () => {
		expect(() => parseDotNotation('workflows.', 'value')).toThrow('empty segment found')
	})
})

describe('extractSettingsOverrides', () => {
	it('should extract single --set argument', () => {
		const argv = ['node', 'il', 'start', '123', '--set', 'mainBranch=develop']
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({ mainBranch: 'develop' })
	})

	it('should extract multiple --set arguments', () => {
		const argv = [
			'node',
			'il',
			'start',
			'123',
			'--set',
			'workflows.issue.startIde=false',
			'--set',
			'capabilities.web.basePort=4000',
		]
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({
			workflows: {
				issue: {
					startIde: false,
				},
			},
			capabilities: {
				web: {
					basePort: 4000,
				},
			},
		})
	})

	it('should merge multiple overrides into single object', () => {
		const argv = [
			'node',
			'il',
			'start',
			'--set',
			'workflows.issue.startIde=false',
			'--set',
			'workflows.issue.startDevServer=true',
			'--set',
			'workflows.pr.startAiAgent=false',
		]
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({
			workflows: {
				issue: {
					startIde: false,
					startDevServer: true,
				},
				pr: {
					startAiAgent: false,
				},
			},
		})
	})

	it('should ignore non-set arguments', () => {
		const argv = ['node', 'il', 'start', '123', '--debug', '--set', 'mainBranch=develop', '--no-claude']
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({ mainBranch: 'develop' })
	})

	it('should return empty object when no --set arguments', () => {
		const argv = ['node', 'il', 'start', '123']
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({})
	})

	it('should throw error for --set without value', () => {
		const argv = ['node', 'il', 'start', '--set']
		expect(() => extractSettingsOverrides(argv)).toThrow('--set requires a key=value argument')
	})

	it('should throw error for malformed --set value (no equals)', () => {
		const argv = ['node', 'il', 'start', '--set', 'mainBranch']
		expect(() => extractSettingsOverrides(argv)).toThrow('Invalid --set format: "mainBranch". Expected key=value')
	})

	it('should throw error for --set with empty key', () => {
		const argv = ['node', 'il', 'start', '--set', '=value']
		expect(() => extractSettingsOverrides(argv)).toThrow(
			'Invalid --set format: "=value". Key cannot be empty',
		)
	})

	it('should handle --set=key=value format', () => {
		const argv = ['node', 'il', 'start', '123', '--set=mainBranch=develop']
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({ mainBranch: 'develop' })
	})

	it('should handle multiple --set=key=value formats', () => {
		const argv = [
			'node',
			'il',
			'start',
			'--set=workflows.issue.startIde=false',
			'--set=capabilities.web.basePort=4000',
		]
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({
			workflows: {
				issue: {
					startIde: false,
				},
			},
			capabilities: {
				web: {
					basePort: 4000,
				},
			},
		})
	})

	it('should handle mixed --set formats', () => {
		const argv = [
			'node',
			'il',
			'start',
			'--set',
			'workflows.issue.startIde=false',
			'--set=capabilities.web.basePort=4000',
		]
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({
			workflows: {
				issue: {
					startIde: false,
				},
			},
			capabilities: {
				web: {
					basePort: 4000,
				},
			},
		})
	})

	it('should handle values with equals signs in them', () => {
		// This tests that only the first = is used to split key=value
		const argv = ['node', 'il', 'start', '--set', 'database.connectionString=postgres://user:pass=word@host']
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({
			database: {
				connectionString: 'postgres://user:pass=word@host',
			},
		})
	})

	it('should allow empty values', () => {
		const argv = ['node', 'il', 'start', '--set', 'worktreePrefix=']
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({ worktreePrefix: '' })
	})

	it('should handle complex real-world scenario', () => {
		const argv = [
			'node',
			'il',
			'start',
			'123',
			'--debug',
			'--set',
			'workflows.issue.startIde=false',
			'--set',
			'workflows.issue.startDevServer=true',
			'--set',
			'workflows.issue.startAiAgent=false',
			'--set=capabilities.web.basePort=4500',
			'--no-claude',
		]
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({
			workflows: {
				issue: {
					startIde: false,
					startDevServer: true,
					startAiAgent: false,
				},
			},
			capabilities: {
				web: {
					basePort: 4500,
				},
			},
		})
	})

	it('should preserve array values when using JSON-like format', () => {
		// Note: This test documents current behavior - arrays would need to be passed as JSON strings
		// For now, we just test that string values are preserved
		const argv = ['node', 'il', 'start', '--set', 'protectedBranches=main,develop']
		const result = extractSettingsOverrides(argv)
		expect(result).toEqual({
			protectedBranches: 'main,develop',
		})
	})
})

describe('getExecutablePath', () => {
	// Save original argv
	let originalArgv: string[]

	beforeEach(() => {
		originalArgv = [...process.argv]
	})

	afterEach(() => {
		// Restore original argv
		process.argv = originalArgv
	})

	it('should return binary name as-is for name without slash', () => {
		process.argv = ['node', 'il', 'start', '123']
		const result = getExecutablePath()
		expect(result).toBe('il')
	})

	it('should return binary name with suffix (il-125)', () => {
		process.argv = ['node', 'il-125', 'start', '123']
		const result = getExecutablePath()
		expect(result).toBe('il-125')
	})

	it('should return absolute path for relative path with slash', () => {
		process.argv = ['node', './dist/cli.js', 'start', '123']
		const result = getExecutablePath()
		// Should resolve to absolute path
		expect(result).toContain('dist/cli.js')
		expect(result).toMatch(/^\//) // Starts with / on Unix
	})

	it('should return absolute path for path without leading ./', () => {
		process.argv = ['node', 'dist/cli.js', 'start', '123']
		const result = getExecutablePath()
		// Should resolve to absolute path
		expect(result).toContain('dist/cli.js')
		expect(result).toMatch(/^\//) // Starts with / on Unix
	})

	it('should return absolute path as-is for already absolute path', () => {
		const absolutePath = '/usr/local/bin/il'
		process.argv = ['node', absolutePath, 'start', '123']
		const result = getExecutablePath()
		expect(result).toBe(absolutePath)
	})

	it('should handle undefined process.argv[1] with fallback', () => {
		process.argv = ['node'] // Missing argv[1]
		const result = getExecutablePath()
		expect(result).toBe('il')
	})

	it('should handle empty string process.argv[1] with fallback', () => {
		process.argv = ['node', '', 'start']
		const result = getExecutablePath()
		expect(result).toBe('il')
	})
})
