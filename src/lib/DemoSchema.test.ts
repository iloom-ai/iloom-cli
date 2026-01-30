import { describe, it, expect } from 'vitest'
import {
	SafeUrlSchema,
	DemoStepSchema,
	DemoAssertionSchema,
	DemoScriptSchema,
	DemoSettingsSchema,
} from './DemoSchema.js'

describe('DemoSchema', () => {
	describe('SafeUrlSchema', () => {
		describe('valid URLs', () => {
			it.each([
				['http://localhost:3000', 'localhost with port'],
				['http://localhost', 'localhost without port'],
				['https://localhost:8080/path', 'localhost https with path'],
				['http://127.0.0.1:3000', '127.0.0.1 with port'],
				['http://127.0.0.1', '127.0.0.1 without port'],
				['https://127.0.0.1:8080/api/test', '127.0.0.1 https with path'],
				['/relative/path', 'relative path'],
				['/api/users', 'relative API path'],
				['/', 'root path'],
			])('accepts %s (%s)', (url) => {
				expect(SafeUrlSchema.safeParse(url).success).toBe(true)
			})
		})

		describe('invalid URLs', () => {
			it.each([
				['https://malicious.com', 'external domain'],
				['http://external-server.com', 'external server'],
				['https://google.com', 'google.com'],
				['http://192.168.1.1:3000', 'local network IP'],
				['ftp://localhost', 'non-http protocol'],
				['not-a-url', 'invalid URL format'],
				['relative-without-slash', 'relative without leading slash'],
			])('rejects %s (%s)', (url) => {
				const result = SafeUrlSchema.safeParse(url)
				expect(result.success).toBe(false)
				if (!result.success) {
					expect(result.error.issues[0].message).toBe(
						'URL must start with http:// or https:// and be localhost, 127.0.0.1, or a relative path starting with /',
					)
				}
			})
		})
	})

	describe('DemoStepSchema', () => {
		describe('valid steps', () => {
			it.each([
				[{ action: 'navigate', target: 'http://localhost:3000', description: 'Go to home' }, 'navigate'],
				[{ action: 'click', target: 'text=Submit', description: 'Click submit' }, 'click'],
				[{ action: 'fill', target: '[data-testid=email]', value: 'test@example.com', description: 'Enter email' }, 'fill'],
				[{ action: 'wait', description: 'Wait for animation' }, 'wait'],
				[{ action: 'press', value: 'Enter', description: 'Press enter key' }, 'press'],
				[{ action: 'screenshot', description: 'Take screenshot' }, 'screenshot'],
			])('accepts valid %s step', (step, _description) => {
				expect(DemoStepSchema.safeParse(step).success).toBe(true)
			})
		})

		describe('invalid steps', () => {
			it('rejects unknown action type', () => {
				const result = DemoStepSchema.safeParse({
					action: 'unknown',
					description: 'Unknown action',
				})
				expect(result.success).toBe(false)
			})

			it('rejects missing description', () => {
				const result = DemoStepSchema.safeParse({
					action: 'click',
					target: 'button',
				})
				expect(result.success).toBe(false)
			})

			it('rejects empty description', () => {
				const result = DemoStepSchema.safeParse({
					action: 'click',
					target: 'button',
					description: '',
				})
				expect(result.success).toBe(false)
			})

			it('rejects navigate without target', () => {
				const result = DemoStepSchema.safeParse({
					action: 'navigate',
					description: 'Navigate somewhere',
				})
				expect(result.success).toBe(false)
			})

			it('rejects click without target', () => {
				const result = DemoStepSchema.safeParse({
					action: 'click',
					description: 'Click something',
				})
				expect(result.success).toBe(false)
			})

			it('rejects fill without target', () => {
				const result = DemoStepSchema.safeParse({
					action: 'fill',
					value: 'test@example.com',
					description: 'Fill email',
				})
				expect(result.success).toBe(false)
			})

			it('rejects fill without value', () => {
				const result = DemoStepSchema.safeParse({
					action: 'fill',
					target: '[data-testid=email]',
					description: 'Fill email',
				})
				expect(result.success).toBe(false)
			})

			it('rejects press without value', () => {
				const result = DemoStepSchema.safeParse({
					action: 'press',
					description: 'Press key',
				})
				expect(result.success).toBe(false)
			})
		})
	})

	describe('DemoAssertionSchema', () => {
		describe('valid assertions', () => {
			it.each([
				[{ type: 'textVisible', value: 'Welcome' }, 'textVisible'],
				[{ type: 'elementExists', value: '[data-testid=header]' }, 'elementExists'],
				[{ type: 'urlMatches', value: '/dashboard' }, 'urlMatches'],
				[{ type: 'textVisible', value: 'Success', timeout: 5000 }, 'with timeout'],
			])('accepts valid %s assertion', (assertion, _description) => {
				expect(DemoAssertionSchema.safeParse(assertion).success).toBe(true)
			})
		})

		describe('invalid assertions', () => {
			it('rejects unknown assertion type', () => {
				const result = DemoAssertionSchema.safeParse({
					type: 'unknownType',
					value: 'test',
				})
				expect(result.success).toBe(false)
			})

			it('rejects missing value', () => {
				const result = DemoAssertionSchema.safeParse({
					type: 'textVisible',
				})
				expect(result.success).toBe(false)
			})

			it('rejects empty value', () => {
				const result = DemoAssertionSchema.safeParse({
					type: 'textVisible',
					value: '',
				})
				expect(result.success).toBe(false)
			})

			it('rejects negative timeout', () => {
				const result = DemoAssertionSchema.safeParse({
					type: 'textVisible',
					value: 'Welcome',
					timeout: -1000,
				})
				expect(result.success).toBe(false)
			})

			it('rejects zero timeout', () => {
				const result = DemoAssertionSchema.safeParse({
					type: 'textVisible',
					value: 'Welcome',
					timeout: 0,
				})
				expect(result.success).toBe(false)
			})
		})
	})

	describe('DemoScriptSchema', () => {
		describe('valid scripts', () => {
			it('accepts complete script with mixed steps and assertions', () => {
				const script = {
					name: 'Login Flow',
					steps: [
						{ action: 'navigate', target: 'http://localhost:3000', description: 'Go to home' },
						{ type: 'textVisible', value: 'Login' },
						{ action: 'fill', target: '[data-testid=email]', value: 'test@example.com', description: 'Enter email' },
						{ action: 'click', target: 'text=Submit', description: 'Click submit' },
						{ type: 'urlMatches', value: '/dashboard' },
					],
				}
				expect(DemoScriptSchema.safeParse(script).success).toBe(true)
			})

			it('accepts script with empty steps array', () => {
				const script = {
					name: 'Empty Script',
					steps: [],
				}
				expect(DemoScriptSchema.safeParse(script).success).toBe(true)
			})
		})

		describe('invalid scripts', () => {
			it('rejects missing name', () => {
				const result = DemoScriptSchema.safeParse({
					steps: [],
				})
				expect(result.success).toBe(false)
			})

			it('rejects empty name', () => {
				const result = DemoScriptSchema.safeParse({
					name: '',
					steps: [],
				})
				expect(result.success).toBe(false)
			})

			it('rejects invalid step in array', () => {
				const result = DemoScriptSchema.safeParse({
					name: 'Test',
					steps: [
						{ action: 'click', target: 'button', description: 'Valid step' },
						{ invalid: 'object' },
					],
				})
				expect(result.success).toBe(false)
			})
		})
	})

	describe('DemoSettingsSchema', () => {
		describe('defaults', () => {
			it('applies correct default values', () => {
				const result = DemoSettingsSchema.parse({})
				expect(result).toEqual({
					enabled: false,
					headless: true,
					baseUrl: 'http://localhost:3000',
					videoDir: '.iloom/demos/',
					timeout: 30000,
				})
			})
		})

		describe('valid configurations', () => {
			it('accepts full configuration', () => {
				const config = {
					enabled: true,
					headless: false,
					baseUrl: 'http://localhost:8080',
					devServerCommand: 'npm run dev',
					videoDir: './videos/',
					timeout: 60000,
				}
				const result = DemoSettingsSchema.safeParse(config)
				expect(result.success).toBe(true)
				if (result.success) {
					expect(result.data).toEqual(config)
				}
			})

			it('accepts partial configuration with defaults', () => {
				const result = DemoSettingsSchema.parse({
					enabled: true,
					devServerCommand: 'pnpm dev',
				})
				expect(result.enabled).toBe(true)
				expect(result.devServerCommand).toBe('pnpm dev')
				expect(result.headless).toBe(true) // default
				expect(result.baseUrl).toBe('http://localhost:3000') // default
			})

			it('accepts 127.0.0.1 as baseUrl', () => {
				const result = DemoSettingsSchema.safeParse({
					baseUrl: 'http://127.0.0.1:5000',
				})
				expect(result.success).toBe(true)
			})
		})

		describe('invalid configurations', () => {
			it('rejects external baseUrl', () => {
				const result = DemoSettingsSchema.safeParse({
					baseUrl: 'https://external.com',
				})
				expect(result.success).toBe(false)
			})

			it('rejects negative timeout', () => {
				const result = DemoSettingsSchema.safeParse({
					timeout: -1000,
				})
				expect(result.success).toBe(false)
			})

			it('rejects zero timeout', () => {
				const result = DemoSettingsSchema.safeParse({
					timeout: 0,
				})
				expect(result.success).toBe(false)
			})
		})
	})
})
