import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SettingsManager, BaseAgentSettingsSchema, SpinAgentSettingsSchema, type IloomSettings } from './SettingsManager.js'
import { readFile } from 'fs/promises'

// Mock fs/promises
vi.mock('fs/promises')
vi.mock('../utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

const defaultSettings = {
	git: { commitTimeout: 60000 },
}

describe('SettingsManager', () => {
	let settingsManager: SettingsManager

	beforeEach(() => {
		settingsManager = new SettingsManager()
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('loadSettings', () => {
		it('should load and parse valid settings.json file', async () => {
			const projectRoot = '/test/project'
			const validSettings = {
				agents: {
					'iloom-issue-analyzer': {
						model: 'sonnet',
					},
					'iloom-issue-planner': {
						model: 'opus',
					},
				},
			}

			// Mock both settings.json and settings.local.json (local.json doesn't exist)
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(validSettings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json (doesn't exist)

			const result = await settingsManager.loadSettings(projectRoot)
			// sourceEnvOnStart defaults to false, attribution defaults to 'upstreamOnly'
			expect(result).toEqual({ ...validSettings, sourceEnvOnStart: false, attribution: 'upstreamOnly', ...defaultSettings })
		})

		it('should return empty object when settings file does not exist', async () => {
			const projectRoot = '/test/project'
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockRejectedValueOnce(error) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			// sourceEnvOnStart defaults to false, attribution defaults to 'upstreamOnly'
			expect(result).toEqual({ sourceEnvOnStart: false, attribution: 'upstreamOnly', ...defaultSettings })
		})

		it('should return empty object when .iloom directory does not exist', async () => {
			const projectRoot = '/test/project'
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockRejectedValueOnce(error) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			// sourceEnvOnStart defaults to false, attribution defaults to 'upstreamOnly'
			expect(result).toEqual({ sourceEnvOnStart: false, attribution: 'upstreamOnly', ...defaultSettings })
		})

		it('should throw error for malformed JSON in settings file', async () => {
			const projectRoot = '/test/project'
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce('invalid json {') // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Failed to parse settings file/,
			)
		})

		it('should throw error for invalid settings structure (not an object)', async () => {
			const projectRoot = '/test/project'
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify('not an object')) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Settings validation failed[\s\S]*Expected object, received string/,
			)
		})

		it('should handle settings file with empty agents object', async () => {
			const projectRoot = '/test/project'
			const emptyAgentsSettings = {
				agents: {},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(emptyAgentsSettings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			// sourceEnvOnStart defaults to false, attribution defaults to 'upstreamOnly'
			expect(result).toEqual({ ...emptyAgentsSettings, sourceEnvOnStart: false, attribution: 'upstreamOnly', ...defaultSettings })
		})

		it('should handle settings file with null agents value', async () => {
			const projectRoot = '/test/project'
			const nullAgentsSettings = {
				agents: null,
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(nullAgentsSettings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			// sourceEnvOnStart defaults to false, attribution defaults to 'upstreamOnly'
			expect(result).toEqual({ ...nullAgentsSettings, sourceEnvOnStart: false, attribution: 'upstreamOnly', ...defaultSettings })
		})

		it('should use process.cwd() when projectRoot not provided', async () => {
			const validSettings = {
				agents: {
					'test-agent': {
						model: 'haiku',
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(validSettings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings()
			// sourceEnvOnStart defaults to false, attribution defaults to 'upstreamOnly'
			expect(result).toEqual({ ...validSettings, sourceEnvOnStart: false, attribution: 'upstreamOnly', ...defaultSettings })
		})

		it('should load settings with mainBranch field', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'develop',
				agents: {},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.mainBranch).toBe('develop')
		})
	})

	describe('AgentSettingsSchema with review config', () => {
		it('should accept enabled: true', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-code-reviewer': {
						enabled: true,
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-code-reviewer']?.enabled).toBe(true)
		})

		it('should accept enabled: false', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-code-reviewer': {
						enabled: false,
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-code-reviewer']?.enabled).toBe(false)
		})

		it('should default enabled to undefined when omitted (defaults to true at runtime)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-code-reviewer': {
						model: 'sonnet',
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			// enabled is undefined in schema (defaults to true at runtime)
			expect(result.agents?.['iloom-code-reviewer']?.enabled).toBeUndefined()
		})

		it('should accept valid providers map with known providers', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-code-reviewer': {
						providers: {
							claude: 'sonnet',
							gemini: 'gemini-2.0-flash',
						},
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-code-reviewer']?.providers?.claude).toBe('sonnet')
			expect(result.agents?.['iloom-code-reviewer']?.providers?.gemini).toBe('gemini-2.0-flash')
		})

		it('should accept empty providers map', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-code-reviewer': {
						providers: {},
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-code-reviewer']?.providers).toEqual({})
		})

		it('should reject invalid provider keys', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-code-reviewer': {
						providers: {
							invalid_provider: 'some-model',
						},
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow()
		})

		it('should accept any string as model name', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-code-reviewer': {
						providers: {
							codex: 'gpt-5.2-codex',
						},
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-code-reviewer']?.providers?.codex).toBe('gpt-5.2-codex')
		})

		it('should coexist with model field', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-code-reviewer': {
						model: 'sonnet',
						enabled: true,
						providers: {
							gemini: 'flash',
						},
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-code-reviewer']?.model).toBe('sonnet')
			expect(result.agents?.['iloom-code-reviewer']?.enabled).toBe(true)
			expect(result.agents?.['iloom-code-reviewer']?.providers?.gemini).toBe('flash')
		})
	})

	describe('validateSettings', () => {
		describe('mainBranch setting validation', () => {
			it('should accept valid mainBranch string setting', () => {
				const settings = {
					mainBranch: 'develop',
				}
				// Should not throw
				expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
			})

			it('should accept "main" as mainBranch', () => {
				const settings = {
					mainBranch: 'main',
				}
				expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
			})

			it('should accept "master" as mainBranch', () => {
				const settings = {
					mainBranch: 'master',
				}
				expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
			})

			it('should throw error when mainBranch is not a string', () => {
				const settings = {
					mainBranch: 123,
				}
				expect(() =>
					settingsManager['validateSettings'](settings as never),
				).toThrow(/mainBranch.*Expected string, received number/)
			})

			it('should throw error when mainBranch is empty string', () => {
				const settings = {
					mainBranch: '',
				}
				expect(() => settingsManager['validateSettings'](settings)).toThrow(
					/mainBranch.*cannot be empty/i,
				)
			})

			it('should accept settings with both mainBranch and agents', () => {
				const settings = {
					mainBranch: 'develop',
					agents: {
						'test-agent': {
							model: 'sonnet' as const,
						},
					},
				}
				expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
			})
		})

	describe('worktreePrefix setting validation', () => {
		it('should accept valid custom prefix with alphanumeric and hyphens', () => {
			const settings = {
				worktreePrefix: 'my-custom-prefix',
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept valid custom prefix with underscores', () => {
			const settings = {
				worktreePrefix: 'my_custom_prefix',
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept valid custom prefix with forward slashes for nested directories', () => {
			const settings = {
				worktreePrefix: 'temp/worktrees',
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept empty string prefix (no prefix mode)', () => {
			const settings = {
				worktreePrefix: '',
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept undefined/omitted prefix (use default calculation)', () => {
			const settings = {}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should reject prefix containing backslash characters', () => {
			const settings = {
				worktreePrefix: 'prefix\\subdir',
			}
			expect(() => settingsManager['validateSettings'](settings)).toThrow(
				/worktreePrefix.*invalid.*character/i,
			)
		})

		it('should reject prefix containing spaces', () => {
			const settings = {
				worktreePrefix: 'my prefix',
			}
			expect(() => settingsManager['validateSettings'](settings)).toThrow(
				/worktreePrefix.*invalid.*character/i,
			)
		})

		it('should reject prefix containing colon', () => {
			const settings = {
				worktreePrefix: 'prefix:name',
			}
			expect(() => settingsManager['validateSettings'](settings)).toThrow(
				/worktreePrefix.*invalid.*character/i,
			)
		})

		it('should reject prefix containing asterisk', () => {
			const settings = {
				worktreePrefix: 'prefix*name',
			}
			expect(() => settingsManager['validateSettings'](settings)).toThrow(
				/worktreePrefix.*invalid.*character/i,
			)
		})

		it('should reject prefix containing question mark', () => {
			const settings = {
				worktreePrefix: 'prefix?name',
			}
			expect(() => settingsManager['validateSettings'](settings)).toThrow(
				/worktreePrefix.*invalid.*character/i,
			)
		})

		it('should reject prefix that is only special characters', () => {
			const settings = {
				worktreePrefix: '---',
			}
			expect(() => settingsManager['validateSettings'](settings)).toThrow(
				/worktreePrefix.*invalid.*character/i,
			)
		})

		it('should accept prefix with trailing dash separator', () => {
			const settings = {
				worktreePrefix: 'prefix-',
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept prefix with trailing underscore separator', () => {
			const settings = {
				worktreePrefix: 'prefix_',
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept prefix with trailing forward slash', () => {
			const settings = {
				worktreePrefix: 'prefix/',
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should reject prefix with segment containing only hyphens', () => {
			const settings = {
				worktreePrefix: 'looms/-',
			}
			expect(() => settingsManager['validateSettings'](settings)).toThrow(
				/worktreePrefix.*invalid.*character/i,
			)
		})

		it('should reject prefix with segment containing only underscores', () => {
			const settings = {
				worktreePrefix: 'temp/_/branches',
			}
			expect(() => settingsManager['validateSettings'](settings)).toThrow(
				/worktreePrefix.*invalid.*character/i,
			)
		})

		it('should reject prefix with first segment containing only hyphens', () => {
			const settings = {
				worktreePrefix: '-/looms',
			}
			expect(() => settingsManager['validateSettings'](settings)).toThrow(
				/worktreePrefix.*invalid.*character/i,
			)
		})

		it('should reject prefix with single segment containing only underscores', () => {
			const settings = {
				worktreePrefix: '___',
			}
			expect(() => settingsManager['validateSettings'](settings)).toThrow(
				/worktreePrefix.*invalid.*character/i,
			)
		})

		it('should accept prefix with segment containing alphanumeric and trailing separator', () => {
			const settings = {
				worktreePrefix: 'looms/myprefix-',
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept prefix with both segments containing alphanumeric content', () => {
			const settings = {
				worktreePrefix: 'temp/branches',
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})
	})

		it('should accept valid settings with all agents configured', () => {
			const validSettings = {
				agents: {
					'iloom-issue-analyzer': {
						model: 'sonnet' as const,
					},
					'iloom-issue-planner': {
						model: 'opus' as const,
					},
					'iloom-issue-implementer': {
						model: 'haiku' as const,
					},
				},
			}

			// Should not throw
			expect(() => settingsManager['validateSettings'](validSettings)).not.toThrow()
		})

		it('should accept valid settings with partial agent configuration', () => {
			const partialSettings = {
				agents: {
					'iloom-issue-implementer': {
						model: 'haiku' as const,
					},
				},
			}

			// Should not throw
			expect(() => settingsManager['validateSettings'](partialSettings)).not.toThrow()
		})

		it('should accept valid settings with empty agents object', () => {
			const emptySettings = {
				agents: {},
			}

			// Should not throw
			expect(() => settingsManager['validateSettings'](emptySettings)).not.toThrow()
		})

		it('should throw error for invalid model names', () => {
			const invalidSettings = {
				agents: {
					'test-agent': {
						model: 'invalid-model',
					},
				},
			}

			expect(() => settingsManager['validateSettings'](invalidSettings as never)).toThrow(
				/Invalid enum value.*Expected 'sonnet' \| 'opus' \| 'haiku'/,
			)
		})

		it('should accept all valid shorthand model names', () => {
			const validModels = ['sonnet', 'opus', 'haiku'] as const

			validModels.forEach(model => {
				const settings = {
					agents: {
						'test-agent': {
							model,
						},
					},
				}

				expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
			})
		})

		it('should handle agent settings without model field', () => {
			const settingsWithoutModel = {
				agents: {
					'test-agent': {},
				},
			}

			// Should not throw - missing model is acceptable
			expect(() => settingsManager['validateSettings'](settingsWithoutModel)).not.toThrow()
		})

		it('should throw error when agents is not an object', () => {
			const invalidSettings = {
				agents: 'not an object',
			}

			expect(() =>
				settingsManager['validateSettings'](invalidSettings as never),
			).toThrow(/agents.*Expected object, received string/)
		})
	})

	describe('getProjectRoot', () => {
		it('should return process.cwd() when no projectRoot provided', () => {
			const result = settingsManager['getProjectRoot']()
			expect(result).toBe(process.cwd())
		})

		it('should return provided projectRoot when given', () => {
			const customRoot = '/custom/project/root'
			const result = settingsManager['getProjectRoot'](customRoot)
			expect(result).toBe(customRoot)
		})
	})

	describe('workflows settings validation', () => {
		it('should accept valid workflows configuration with issue and pr permission modes', () => {
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'bypassPermissions' as const,
					},
					pr: {
						permissionMode: 'acceptEdits' as const,
					},
				},
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept workflows with only issue configuration', () => {
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'plan' as const,
					},
				},
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept workflows with only pr configuration', () => {
			const settings = {
				workflows: {
					pr: {
						permissionMode: 'acceptEdits' as const,
					},
				},
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept all valid permission mode values: plan, acceptEdits, bypassPermissions, default', () => {
			const validModes = ['plan', 'acceptEdits', 'bypassPermissions', 'default'] as const

			validModes.forEach(mode => {
				const settings = {
					workflows: {
						issue: {
							permissionMode: mode,
						},
					},
				}
				expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
			})
		})

		it('should throw error for invalid permission mode value', () => {
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'invalidMode',
					},
				},
			}
			expect(() =>
				settingsManager['validateSettings'](settings as never),
			).toThrow(/Invalid enum value/)
		})

		it('should throw error when permissionMode is not a string', () => {
			const settings = {
				workflows: {
					issue: {
						permissionMode: 123,
					},
				},
			}
			expect(() =>
				settingsManager['validateSettings'](settings as never),
			).toThrow(/received number/)
		})

		it('should accept settings with workflows, mainBranch, and agents combined', () => {
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'bypassPermissions' as const,
					},
				},
				mainBranch: 'develop',
				agents: {
					'test-agent': {
						model: 'sonnet' as const,
					},
				},
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept empty workflows object', () => {
			const settings = {
				workflows: {},
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})

		it('should accept regular workflow permission mode configuration', () => {
			const settings = {
				workflows: {
					regular: {
						permissionMode: 'plan' as const,
					},
				},
			}
			expect(() => settingsManager['validateSettings'](settings)).not.toThrow()
		})
	})

	describe('workflows.{type}.noVerify configuration', () => {
		it('should accept valid noVerify boolean in workflows.issue', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'plan',
						noVerify: true,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.noVerify).toBe(true)
		})

		it('should accept valid noVerify boolean in workflows.pr', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					pr: {
						permissionMode: 'acceptEdits',
						noVerify: false,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.pr?.noVerify).toBe(false)
		})

		it('should accept missing noVerify field (defaults to undefined)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'plan',
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.noVerify).toBeUndefined()
		})

		it('should reject invalid noVerify types (non-boolean)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'plan',
						noVerify: 'true', // String instead of boolean
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Settings validation failed[\s\S]*workflows\.issue\.noVerify[\s\S]*Expected boolean, received string/,
			)
		})

		it('should handle multiple workflow types with different noVerify settings', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'plan',
						noVerify: true,
					},
					pr: {
						permissionMode: 'acceptEdits',
						noVerify: false,
					},
					regular: {
						permissionMode: 'bypassPermissions',
						noVerify: true,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.noVerify).toBe(true)
			expect(result.workflows?.pr?.noVerify).toBe(false)
			expect(result.workflows?.regular?.noVerify).toBe(true)
		})
	})

	describe('loadSettings with workflows', () => {
		it('should load settings with workflows configuration correctly', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'bypassPermissions',
					},
					pr: {
						permissionMode: 'acceptEdits',
					},
				},
				mainBranch: 'develop',
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.permissionMode).toBe('bypassPermissions')
			expect(result.workflows?.issue?.startIde).toBe(true) // Zod default
			expect(result.workflows?.issue?.startDevServer).toBe(true) // Zod default
			expect(result.workflows?.issue?.startAiAgent).toBe(true) // Zod default
			expect(result.workflows?.pr?.permissionMode).toBe('acceptEdits')
			expect(result.workflows?.pr?.startIde).toBe(true) // Zod default
			expect(result.workflows?.pr?.startDevServer).toBe(true) // Zod default
			expect(result.workflows?.pr?.startAiAgent).toBe(true) // Zod default
			expect(result.mainBranch).toBe('develop')
		})

		it('should handle settings with partial workflows (issue only)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'plan',
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.permissionMode).toBe('plan')
			expect(result.workflows?.pr).toBeUndefined()
		})

		it('should handle settings with partial workflows (pr only)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					pr: {
						permissionMode: 'acceptEdits',
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.pr?.permissionMode).toBe('acceptEdits')
			expect(result.workflows?.issue).toBeUndefined()
		})
	})

	describe('capabilities.web.basePort configuration', () => {
		it('should accept valid basePort value (8080)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				capabilities: {
					web: {
						basePort: 8080,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.capabilities?.web?.basePort).toBe(8080)
		})

		it('should accept valid basePort value (3000)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				capabilities: {
					web: {
						basePort: 3000,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.capabilities?.web?.basePort).toBe(3000)
		})

		it('should accept valid basePort value (65535 - maximum)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				capabilities: {
					web: {
						basePort: 65535,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.capabilities?.web?.basePort).toBe(65535)
		})

		it('should accept valid basePort value (1 - minimum)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				capabilities: {
					web: {
						basePort: 1,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.capabilities?.web?.basePort).toBe(1)
		})

		it('should accept valid basePort value (80 - well-known port)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				capabilities: {
					web: {
						basePort: 80,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.capabilities?.web?.basePort).toBe(80)
		})

		it('should reject basePort < 1', async () => {
			const projectRoot = '/test/project'
			const settings = {
				capabilities: {
					web: {
						basePort: 0,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Settings validation failed[\s\S]*capabilities\.web\.basePort[\s\S]*Base port must be >= 1/,
			)
		})

		it('should reject basePort > 65535', async () => {
			const projectRoot = '/test/project'
			const settings = {
				capabilities: {
					web: {
						basePort: 65536,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Settings validation failed[\s\S]*capabilities\.web\.basePort[\s\S]*Base port must be <= 65535/,
			)
		})

		it('should reject basePort that is not a number', async () => {
			const projectRoot = '/test/project'
			const settings = {
				capabilities: {
					web: {
						basePort: '8080',
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Settings validation failed[\s\S]*capabilities\.web\.basePort[\s\S]*Expected number, received string/,
			)
		})

		it('should accept missing capabilities.web.basePort (uses default)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.capabilities?.web?.basePort).toBeUndefined()
		})

		it('should accept missing capabilities object entirely', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				agents: {},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.capabilities).toBeUndefined()
		})

		it('should preserve other settings when basePort is added', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'develop',
				workflows: {
					issue: {
						permissionMode: 'bypassPermissions',
					},
				},
				agents: {
					'test-agent': {
						model: 'sonnet',
					},
				},
				capabilities: {
					web: {
						basePort: 8080,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.mainBranch).toBe('develop')
			expect(result.workflows?.issue?.permissionMode).toBe('bypassPermissions')
			expect(result.agents?.['test-agent']?.model).toBe('sonnet')
			expect(result.capabilities?.web?.basePort).toBe(8080)
		})
	})

	describe('WorkflowPermissionSchema - Component Launch Configuration', () => {
		it('should validate workflow config with all component flags enabled', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						startIde: true,
						startDevServer: true,
						startAiAgent: true,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.startIde).toBe(true)
			expect(result.workflows?.issue?.startDevServer).toBe(true)
			expect(result.workflows?.issue?.startAiAgent).toBe(true)
		})

		it('should validate workflow config with all component flags disabled', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						startIde: false,
						startDevServer: false,
						startAiAgent: false,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.startIde).toBe(false)
			expect(result.workflows?.issue?.startDevServer).toBe(false)
			expect(result.workflows?.issue?.startAiAgent).toBe(false)
		})

		it('should validate workflow config with mixed component flags', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						startIde: true,
						startDevServer: false,
						startAiAgent: true,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.startIde).toBe(true)
			expect(result.workflows?.issue?.startDevServer).toBe(false)
			expect(result.workflows?.issue?.startAiAgent).toBe(true)
		})

		it('should apply default true to component flags when not specified', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'plan',
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.startIde).toBe(true)
			expect(result.workflows?.issue?.startDevServer).toBe(true)
			expect(result.workflows?.issue?.startAiAgent).toBe(true)
		})

		it('should accept different workflow types (issue, pr, regular) with component configs', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						startIde: true,
						startDevServer: false,
						startAiAgent: true,
					},
					pr: {
						startIde: false,
						startDevServer: true,
						startAiAgent: false,
					},
					regular: {
						startIde: true,
						startDevServer: true,
						startAiAgent: false,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.startIde).toBe(true)
			expect(result.workflows?.issue?.startDevServer).toBe(false)
			expect(result.workflows?.issue?.startAiAgent).toBe(true)
			expect(result.workflows?.pr?.startIde).toBe(false)
			expect(result.workflows?.pr?.startDevServer).toBe(true)
			expect(result.workflows?.pr?.startAiAgent).toBe(false)
			expect(result.workflows?.regular?.startIde).toBe(true)
			expect(result.workflows?.regular?.startDevServer).toBe(true)
			expect(result.workflows?.regular?.startAiAgent).toBe(false)
		})

		it('should reject invalid types for component launch flags (non-boolean)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						startIde: 'yes',
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Settings validation failed[\s\S]*workflows\.issue\.startIde[\s\S]*Expected boolean, received string/,
			)
		})

		it('should reject invalid startDevServer type (number)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						startDevServer: 1,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Settings validation failed[\s\S]*workflows\.issue\.startDevServer[\s\S]*Expected boolean, received number/,
			)
		})

		it('should reject invalid startAiAgent type (null)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						startAiAgent: null,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Settings validation failed[\s\S]*workflows\.issue\.startAiAgent[\s\S]*Expected boolean/,
			)
		})

		it('should accept component flags alongside existing workflow settings', async () => {
			const projectRoot = '/test/project'
			const settings = {
				workflows: {
					issue: {
						permissionMode: 'bypassPermissions',
						noVerify: true,
						startIde: false,
						startDevServer: true,
						startAiAgent: false,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.workflows?.issue?.permissionMode).toBe('bypassPermissions')
			expect(result.workflows?.issue?.noVerify).toBe(true)
			expect(result.workflows?.issue?.startIde).toBe(false)
			expect(result.workflows?.issue?.startDevServer).toBe(true)
			expect(result.workflows?.issue?.startAiAgent).toBe(false)
		})
	})

	describe('settings.local.json priority', () => {
		it('should merge settings.local.json over settings.json', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				mainBranch: 'main',
				agents: {
					'test-agent': {
						model: 'sonnet',
					},
				},
			}
			const localSettings = {
				mainBranch: 'develop',
				agents: {
					'test-agent': {
						model: 'opus',
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			// Mock readFile to return different content for each file
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
			.mockResolvedValueOnce(JSON.stringify(localSettings)) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)

			// Local settings should override base settings
			expect(result.mainBranch).toBe('develop')
			expect(result.agents?.['test-agent']?.model).toBe('opus')
		})

		it('should use settings.local.json when settings.json missing', async () => {
			const projectRoot = '/test/project'
			const localSettings = {
				mainBranch: 'develop',
				agents: {
					'test-agent': {
						model: 'haiku',
					},
				},
			}

			// settings.json returns ENOENT, settings.local.json returns content
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockRejectedValueOnce(error) // settings.json
				.mockResolvedValueOnce(JSON.stringify(localSettings)) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)

			expect(result.mainBranch).toBe('develop')
			expect(result.agents?.['test-agent']?.model).toBe('haiku')
		})

		it('should validate settings.local.json with same schema', async () => {
			const projectRoot = '/test/project'
			const invalidLocalSettings = {
				mainBranch: 123, // Invalid: should be string
			}

			// global settings returns ENOENT, settings.json returns ENOENT, settings.local.json has invalid content
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockRejectedValueOnce(error) // settings.json
				.mockResolvedValueOnce(JSON.stringify(invalidLocalSettings)) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Settings validation failed[\s\S]*mainBranch[\s\S]*Expected string, received number/,
			)
		})

		it('should throw on malformed settings.local.json', async () => {
			const projectRoot = '/test/project'

			// settings.json returns ENOENT, settings.local.json has invalid JSON
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockRejectedValueOnce(error) // settings.json
			.mockResolvedValueOnce('invalid json {') // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Failed to parse settings file.*settings\.local\.json/,
			)
		})

		it('should handle when both files missing (return empty object)', async () => {
			const projectRoot = '/test/project'

			// Both files return ENOENT
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockRejectedValueOnce(error) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)

			// sourceEnvOnStart defaults to false, attribution defaults to 'upstreamOnly'
			expect(result).toEqual({ sourceEnvOnStart: false, attribution: 'upstreamOnly', ...defaultSettings })
		})

		it('should deep merge workflows with partial overrides', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				workflows: {
					issue: {
						permissionMode: 'plan',
						startIde: true,
						startDevServer: true,
					},
					pr: {
						permissionMode: 'acceptEdits',
					},
				},
			}
			const localSettings = {
				workflows: {
					issue: {
						permissionMode: 'bypassPermissions',
						// startIde and startDevServer not specified, should inherit from base
					},
					// pr not specified, should inherit from base
				},
			}

const error: { code?: string; message: string } = {
	code: 'ENOENT',
	message: 'ENOENT: no such file or directory',
}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings))
			.mockResolvedValueOnce(JSON.stringify(localSettings))

			const result = await settingsManager.loadSettings(projectRoot)

			expect(result.workflows?.issue?.permissionMode).toBe('bypassPermissions')
			expect(result.workflows?.issue?.startIde).toBe(true) // Inherited
			expect(result.workflows?.issue?.startDevServer).toBe(true) // Inherited + Zod default
			expect(result.workflows?.pr?.permissionMode).toBe('acceptEdits') // Inherited
		})

		it('should preserve base values when local overrides do not specify them (issue #235)', async () => {
			const projectRoot = '/test/project'
			// Base has NON-DEFAULT values (startDevServer: false, startTerminal: true)
			const baseSettings = {
				workflows: {
					issue: {
						startDevServer: false, // Default is true
						startTerminal: true, // Default is false
						startIde: true,
					},
				},
			}
			// Local only specifies permissionMode - should NOT pollute with defaults
			const localSettings = {
				workflows: {
					issue: {
						permissionMode: 'bypassPermissions',
					},
				},
			}

const error: { code?: string; message: string } = {
	code: 'ENOENT',
	message: 'ENOENT: no such file or directory',
}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings))
			.mockResolvedValueOnce(JSON.stringify(localSettings))

			const result = await settingsManager.loadSettings(projectRoot)

			// Values from base should be preserved, NOT overwritten by Zod defaults
			expect(result.workflows?.issue?.startDevServer).toBe(false) // NOT true (default)
			expect(result.workflows?.issue?.startTerminal).toBe(true) // NOT false (default)
			expect(result.workflows?.issue?.startIde).toBe(true) // Preserved from base
			expect(result.workflows?.issue?.permissionMode).toBe('bypassPermissions') // From local
		})

		it('should deep merge agents with partial overrides', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				agents: {
					'agent-1': {
						model: 'sonnet',
					},
					'agent-2': {
						model: 'opus',
					},
				},
			}
			const localSettings = {
				agents: {
					'agent-1': {
						model: 'haiku', // Override
					},
					// agent-2 not specified, should inherit from base
				},
			}

const error: { code?: string; message: string } = {
	code: 'ENOENT',
	message: 'ENOENT: no such file or directory',
}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings))
			.mockResolvedValueOnce(JSON.stringify(localSettings))

			const result = await settingsManager.loadSettings(projectRoot)

			expect(result.agents?.['agent-1']?.model).toBe('haiku') // Overridden
			expect(result.agents?.['agent-2']?.model).toBe('opus') // Inherited
		})

		it('should deep merge capabilities.web.basePort', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				capabilities: {
					web: {
						basePort: 3000,
					},
				},
			}
			const localSettings = {
				capabilities: {
					web: {
						basePort: 8080,
					},
				},
			}

const error: { code?: string; message: string } = {
	code: 'ENOENT',
	message: 'ENOENT: no such file or directory',
}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings))
			.mockResolvedValueOnce(JSON.stringify(localSettings))

			const result = await settingsManager.loadSettings(projectRoot)

			expect(result.capabilities?.web?.basePort).toBe(8080) // Overridden
		})

		it('should replace arrays (protectedBranches) not concatenate', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				protectedBranches: ['main', 'master', 'develop'],
			}
			const localSettings = {
				protectedBranches: ['production', 'staging'],
			}

const error: { code?: string; message: string } = {
	code: 'ENOENT',
	message: 'ENOENT: no such file or directory',
}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings))
			.mockResolvedValueOnce(JSON.stringify(localSettings))

			const result = await settingsManager.loadSettings(projectRoot)

			expect(result.protectedBranches).toEqual(['production', 'staging']) // Replaced
		})
	})

	describe('getProtectedBranches', () => {
		it('should return default protected branches when no settings configured', async () => {
			const projectRoot = '/test/project'
			// Return empty settings (ENOENT)
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockRejectedValueOnce(error) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.getProtectedBranches(projectRoot)

			// Should return defaults with 'main' as default mainBranch
			expect(result).toEqual(['main', 'main', 'master', 'develop'])
		})

		it('should return default protected branches with custom mainBranch', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'develop',
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.getProtectedBranches(projectRoot)

			// Should return defaults with 'develop' as mainBranch
			expect(result).toEqual(['develop', 'main', 'master', 'develop'])
		})

		it('should use configured protectedBranches and ensure mainBranch is included', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				protectedBranches: ['production', 'staging'],
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.getProtectedBranches(projectRoot)

			// Should prepend mainBranch to configured list
			expect(result).toEqual(['main', 'production', 'staging'])
		})

		it('should not duplicate mainBranch if already in protectedBranches', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				protectedBranches: ['main', 'production', 'staging'],
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.getProtectedBranches(projectRoot)

			// Should use configured list as-is since mainBranch is already included
			expect(result).toEqual(['main', 'production', 'staging'])
		})

		it('should add custom mainBranch to configured protectedBranches if not present', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'develop',
				protectedBranches: ['main', 'master', 'production'],
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.getProtectedBranches(projectRoot)

			// Should prepend 'develop' to configured list
			expect(result).toEqual(['develop', 'main', 'master', 'production'])
		})

		it('should handle empty protectedBranches array', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				protectedBranches: [],
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.getProtectedBranches(projectRoot)

			// Should add mainBranch to empty configured list
			expect(result).toEqual(['main'])
		})

		it('should use process.cwd() when projectRoot not provided', async () => {
			const settings = {
				mainBranch: 'main',
				protectedBranches: ['production'],
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.getProtectedBranches()

			// Should work without explicit projectRoot
			expect(result).toEqual(['main', 'production'])
		})

		it('should handle master as mainBranch with configured protectedBranches', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'master',
				protectedBranches: ['main', 'develop'],
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.getProtectedBranches(projectRoot)

			// Should prepend 'master' to configured list
			expect(result).toEqual(['master', 'main', 'develop'])
		})

		it('should handle mainBranch already in middle of protectedBranches list', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				protectedBranches: ['production', 'main', 'staging'],
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.getProtectedBranches(projectRoot)

			// Should use configured list as-is since mainBranch is already included
			expect(result).toEqual(['production', 'main', 'staging'])
		})

		it('should handle mainBranch at end of protectedBranches list', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				protectedBranches: ['production', 'staging', 'main'],
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.getProtectedBranches(projectRoot)

			// Should use configured list as-is since mainBranch is already included
			expect(result).toEqual(['production', 'staging', 'main'])
		})
	})

	describe('loadSettings with CLI overrides', () => {
		it('should merge CLI overrides with highest priority', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				mainBranch: 'main',
				workflows: {
					issue: {
						startIde: true,
						startDevServer: true,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const cliOverrides = {
				mainBranch: 'develop',
				workflows: {
					issue: {
						startIde: false,
					},
				},
			}

			const result = await settingsManager.loadSettings(projectRoot, cliOverrides)
			expect(result.mainBranch).toBe('develop') // CLI override
			expect(result.workflows?.issue?.startIde).toBe(false) // CLI override
			expect(result.workflows?.issue?.startDevServer).toBe(true) // Base setting preserved
		})

		it('should validate CLI overrides against schema', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				mainBranch: 'main',
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			// Invalid CLI overrides (invalid model name)
			const cliOverrides = {
				agents: {
					'test-agent': {
						model: 'invalid-model' as 'sonnet', // Type cast to bypass TypeScript
					},
				},
			}

			await expect(settingsManager.loadSettings(projectRoot, cliOverrides)).rejects.toThrow(
				'Settings validation failed',
			)
		})

		it('should apply CLI overrides over local settings', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				mainBranch: 'main',
				workflows: {
					issue: {
						startIde: true,
					},
				},
			}

			const localSettings = {
				mainBranch: 'staging',
				workflows: {
					issue: {
						startIde: false,
					},
				},
			}

const error: { code?: string; message: string } = {
	code: 'ENOENT',
	message: 'ENOENT: no such file or directory',
}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
			.mockResolvedValueOnce(JSON.stringify(localSettings)) // settings.local.json

			const cliOverrides = {
				mainBranch: 'develop',
			}

			const result = await settingsManager.loadSettings(projectRoot, cliOverrides)
			expect(result.mainBranch).toBe('develop') // CLI override (highest priority)
			expect(result.workflows?.issue?.startIde).toBe(false) // Local setting (second priority)
		})

		it('should handle deep merge of CLI overrides', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				workflows: {
					issue: {
						startIde: true,
						startDevServer: true,
						startAiAgent: true,
					},
					pr: {
						startIde: true,
						startDevServer: true,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const cliOverrides = {
				workflows: {
					issue: {
						startIde: false, // Override this one field
					},
				},
			}

			const result = await settingsManager.loadSettings(projectRoot, cliOverrides)
			expect(result.workflows?.issue?.startIde).toBe(false) // Overridden
			expect(result.workflows?.issue?.startDevServer).toBe(true) // Preserved
			expect(result.workflows?.issue?.startAiAgent).toBe(true) // Preserved
			expect(result.workflows?.pr?.startIde).toBe(true) // Preserved
		})

		it('should handle empty CLI overrides', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				mainBranch: 'main',
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot, {})
			expect(result.mainBranch).toBe('main')
		})

		it('should enhance error message when CLI overrides cause validation failure', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				mainBranch: 'main',
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const cliOverrides = {
				capabilities: {
					web: {
						basePort: 70000, // Invalid: > 65535
					},
				},
			}

			try {
				await settingsManager.loadSettings(projectRoot, cliOverrides)
				expect.fail('Should have thrown error')
			} catch (error) {
				expect(error).toBeInstanceOf(Error)
				const err = error as Error
				expect(err.message).toContain('Settings validation failed')
				expect(err.message).toContain('CLI overrides were applied')
				expect(err.message).toContain('Check your --set arguments')
			}
		})
	})

	describe('sourceEnvOnStart setting', () => {
		it('should default to false when not specified', async () => {
			const projectRoot = '/test/project'
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockRejectedValueOnce(error) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.sourceEnvOnStart).toBe(false)
		})

		it('should accept false value', async () => {
			const projectRoot = '/test/project'
			const settings = { sourceEnvOnStart: false }
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.sourceEnvOnStart).toBe(false)
		})

		it('should accept true value explicitly', async () => {
			const projectRoot = '/test/project'
			const settings = { sourceEnvOnStart: true }
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.sourceEnvOnStart).toBe(true)
		})

		it('should reject non-boolean values', async () => {
			const projectRoot = '/test/project'
			const settings = { sourceEnvOnStart: 'yes' }
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}
			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/received string/,
			)
		})
	})

	describe('global settings', () => {
		describe('getGlobalSettingsPath', () => {
			it('should return path in ~/.config/iloom-ai/settings.json', () => {
				const settingsPath = settingsManager['getGlobalSettingsPath']()
				expect(settingsPath).toContain('.config')
				expect(settingsPath).toContain('iloom-ai')
				expect(settingsPath).toContain('settings.json')
			})
		})

		describe('loadGlobalSettingsFile', () => {
			it('should load and parse valid global settings file', async () => {
				const validGlobalSettings = {
					workflows: {
						issue: {
							permissionMode: 'bypassPermissions',
						},
					},
				}

				vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(validGlobalSettings))

				const result = await settingsManager['loadGlobalSettingsFile']()
				expect(result).toEqual(validGlobalSettings)
			})

			it('should return empty object when global settings file does not exist', async () => {
				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}
				vi.mocked(readFile).mockRejectedValueOnce(error)

				const result = await settingsManager['loadGlobalSettingsFile']()
				expect(result).toEqual({})
			})

			it('should warn but return empty object on invalid JSON', async () => {
				vi.mocked(readFile).mockResolvedValueOnce('invalid json {')

				const result = await settingsManager['loadGlobalSettingsFile']()
				expect(result).toEqual({})
			})

			it('should warn but return empty object on validation error', async () => {
				const invalidSettings = {
					mainBranch: 123, // Invalid: should be string
				}
				vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(invalidSettings))

				const result = await settingsManager['loadGlobalSettingsFile']()
				expect(result).toEqual({})
			})
		})

		describe('loadSettings with global settings', () => {
			it('should merge global settings at lowest priority', async () => {
				const projectRoot = '/test/project'
				const globalSettings = {
					mainBranch: 'global-branch',
					workflows: {
						issue: {
							permissionMode: 'plan',
						},
					},
				}
				const baseSettings = {
					mainBranch: 'main',
				}

				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockResolvedValueOnce(JSON.stringify(globalSettings)) // global settings
					.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
					.mockRejectedValueOnce(error) // settings.local.json

				const result = await settingsManager.loadSettings(projectRoot)
				// Project settings should override global
				expect(result.mainBranch).toBe('main')
				// Global workflows should be preserved (not overridden)
				expect(result.workflows?.issue?.permissionMode).toBe('plan')
			})

			it('should allow project settings to override global settings', async () => {
				const projectRoot = '/test/project'
				const globalSettings = {
					workflows: {
						issue: {
							permissionMode: 'plan',
							startIde: false,
						},
					},
				}
				const baseSettings = {
					workflows: {
						issue: {
							permissionMode: 'bypassPermissions',
						},
					},
				}

				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockResolvedValueOnce(JSON.stringify(globalSettings)) // global settings
					.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
					.mockRejectedValueOnce(error) // settings.local.json

				const result = await settingsManager.loadSettings(projectRoot)
				// Project setting should override global
				expect(result.workflows?.issue?.permissionMode).toBe('bypassPermissions')
				// Global startIde should be preserved (not in project settings)
				expect(result.workflows?.issue?.startIde).toBe(false)
			})

			it('should allow local settings to override both global and project settings', async () => {
				const projectRoot = '/test/project'
				const globalSettings = {
					mainBranch: 'global-branch',
					workflows: {
						issue: {
							permissionMode: 'plan',
						},
					},
				}
				const baseSettings = {
					mainBranch: 'main',
				}
				const localSettings = {
					mainBranch: 'local-branch',
					workflows: {
						issue: {
							permissionMode: 'acceptEdits',
						},
					},
				}

				vi.mocked(readFile)
					.mockResolvedValueOnce(JSON.stringify(globalSettings)) // global settings
					.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
					.mockResolvedValueOnce(JSON.stringify(localSettings)) // settings.local.json

				const result = await settingsManager.loadSettings(projectRoot)
				// Local settings should override both
				expect(result.mainBranch).toBe('local-branch')
				expect(result.workflows?.issue?.permissionMode).toBe('acceptEdits')
			})

			it('should allow CLI overrides to override all other settings', async () => {
				const projectRoot = '/test/project'
				const globalSettings = {
					mainBranch: 'global-branch',
				}
				const baseSettings = {
					mainBranch: 'main',
				}
				const localSettings = {
					mainBranch: 'local-branch',
				}
				const cliOverrides = {
					mainBranch: 'cli-branch',
				}

				vi.mocked(readFile)
					.mockResolvedValueOnce(JSON.stringify(globalSettings)) // global settings
					.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
					.mockResolvedValueOnce(JSON.stringify(localSettings)) // settings.local.json

				const result = await settingsManager.loadSettings(projectRoot, cliOverrides)
				// CLI override should win
				expect(result.mainBranch).toBe('cli-branch')
			})

			it('should deep merge nested global settings (workflows, agents)', async () => {
				const projectRoot = '/test/project'
				const globalSettings = {
					workflows: {
						issue: {
							startIde: false,
							startDevServer: false,
						},
						pr: {
							permissionMode: 'plan',
						},
					},
					agents: {
						'agent-1': {
							model: 'opus',
						},
					},
				}
				const baseSettings = {
					workflows: {
						issue: {
							permissionMode: 'bypassPermissions',
						},
					},
				}

				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockResolvedValueOnce(JSON.stringify(globalSettings)) // global settings
					.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
					.mockRejectedValueOnce(error) // settings.local.json

				const result = await settingsManager.loadSettings(projectRoot)
				// Deep merge should preserve global values not in project
				expect(result.workflows?.issue?.startIde).toBe(false) // From global
				expect(result.workflows?.issue?.startDevServer).toBe(false) // From global
				expect(result.workflows?.issue?.permissionMode).toBe('bypassPermissions') // From project
				expect(result.workflows?.pr?.permissionMode).toBe('plan') // From global
				expect(result.agents?.['agent-1']?.model).toBe('opus') // From global
			})

			it('should handle missing global file gracefully', async () => {
				const projectRoot = '/test/project'
				const baseSettings = {
					mainBranch: 'main',
				}

				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockRejectedValueOnce(error) // global settings (missing)
					.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
					.mockRejectedValueOnce(error) // settings.local.json

				const result = await settingsManager.loadSettings(projectRoot)
				expect(result.mainBranch).toBe('main')
			})

			it('should handle missing project files with only global settings', async () => {
				const projectRoot = '/test/project'
				const globalSettings = {
					mainBranch: 'global-main',
					workflows: {
						issue: {
							permissionMode: 'bypassPermissions',
						},
					},
				}

				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockResolvedValueOnce(JSON.stringify(globalSettings)) // global settings
					.mockRejectedValueOnce(error) // settings.json (missing)
					.mockRejectedValueOnce(error) // settings.local.json (missing)

				const result = await settingsManager.loadSettings(projectRoot)
				expect(result.mainBranch).toBe('global-main')
				expect(result.workflows?.issue?.permissionMode).toBe('bypassPermissions')
			})

			it('should replace arrays from global with project arrays', async () => {
				const projectRoot = '/test/project'
				const globalSettings = {
					protectedBranches: ['global-1', 'global-2'],
				}
				const baseSettings = {
					protectedBranches: ['project-1', 'project-2'],
				}

				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockResolvedValueOnce(JSON.stringify(globalSettings)) // global settings
					.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
					.mockRejectedValueOnce(error) // settings.local.json

				const result = await settingsManager.loadSettings(projectRoot)
				// Arrays should be replaced, not concatenated
				expect(result.protectedBranches).toEqual(['project-1', 'project-2'])
			})
		})

		describe('colors settings', () => {
			it('should default colors.terminal to true when colors object is provided', async () => {
				const projectRoot = '/test/project'
				const projectSettings = {
					colors: {}, // Empty colors object should trigger defaults
				}
				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockRejectedValueOnce(error) // global settings (missing)
					.mockResolvedValueOnce(JSON.stringify(projectSettings)) // settings.json
					.mockRejectedValueOnce(error) // settings.local.json (missing)

				const result = await settingsManager.loadSettings(projectRoot)
				expect(result.colors?.terminal).toBe(true)
			})

			it('should default colors.vscode to false when colors object is provided', async () => {
				const projectRoot = '/test/project'
				const projectSettings = {
					colors: {}, // Empty colors object should trigger defaults
				}
				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockRejectedValueOnce(error) // global settings (missing)
					.mockResolvedValueOnce(JSON.stringify(projectSettings)) // settings.json
					.mockRejectedValueOnce(error) // settings.local.json (missing)

				const result = await settingsManager.loadSettings(projectRoot)
				expect(result.colors?.vscode).toBe(false)
			})

			it('should accept missing colors object entirely', async () => {
				const projectRoot = '/test/project'
				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockRejectedValueOnce(error) // global settings (missing)
					.mockResolvedValueOnce(JSON.stringify({})) // settings.json (empty)
					.mockRejectedValueOnce(error) // settings.local.json (missing)

				const result = await settingsManager.loadSettings(projectRoot)
				expect(result.colors).toBeUndefined()
			})

			it('should accept colors.terminal = false', async () => {
				const projectRoot = '/test/project'
				const projectSettings = {
					colors: { terminal: false },
				}
				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockRejectedValueOnce(error) // global settings (missing)
					.mockResolvedValueOnce(JSON.stringify(projectSettings)) // settings.json
					.mockRejectedValueOnce(error) // settings.local.json (missing)

				const result = await settingsManager.loadSettings(projectRoot)
				expect(result.colors?.terminal).toBe(false)
			})

			it('should accept colors.vscode = true (explicit enable)', async () => {
				const projectRoot = '/test/project'
				const projectSettings = {
					colors: { vscode: true },
				}
				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockRejectedValueOnce(error) // global settings (missing)
					.mockResolvedValueOnce(JSON.stringify(projectSettings)) // settings.json
					.mockRejectedValueOnce(error) // settings.local.json (missing)

				const result = await settingsManager.loadSettings(projectRoot)
				expect(result.colors?.vscode).toBe(true)
			})

			it('should merge colors from local and project settings', async () => {
				const projectRoot = '/test/project'
				const projectSettings = {
					colors: { terminal: true, vscode: false },
				}
				const localSettings = {
					colors: { vscode: true }, // Override vscode setting
				}

				const error: { code?: string; message: string } = {
					code: 'ENOENT',
					message: 'ENOENT: no such file or directory',
				}

				vi.mocked(readFile)
					.mockRejectedValueOnce(error) // global settings (missing)
					.mockResolvedValueOnce(JSON.stringify(projectSettings)) // settings.json
					.mockResolvedValueOnce(JSON.stringify(localSettings)) // settings.local.json

				const result = await settingsManager.loadSettings(projectRoot)
				expect(result.colors?.terminal).toBe(true) // From project
				expect(result.colors?.vscode).toBe(true) // Overridden by local
			})
		})
	})

	describe('getSpinModel', () => {
		it('should return opus by default when spin not configured', () => {
			const settings = { sourceEnvOnStart: false }
			const result = settingsManager.getSpinModel(settings)
			expect(result).toBe('opus')
		})

		it('should return configured model when spin.model is set to sonnet', () => {
			const settings = { sourceEnvOnStart: false, spin: { model: 'sonnet' as const } }
			const result = settingsManager.getSpinModel(settings)
			expect(result).toBe('sonnet')
		})

		it('should return configured model when spin.model is set to haiku', () => {
			const settings = { sourceEnvOnStart: false, spin: { model: 'haiku' as const } }
			const result = settingsManager.getSpinModel(settings)
			expect(result).toBe('haiku')
		})

		it('should return configured model when spin.model is set to opus', () => {
			const settings = { sourceEnvOnStart: false, spin: { model: 'opus' as const } }
			const result = settingsManager.getSpinModel(settings)
			expect(result).toBe('opus')
		})

		it('should return opus when spin object exists but model not set', () => {
			// This tests the Zod default behavior - when spin object is parsed without model
			// the default 'opus' should be applied
			const settings = { sourceEnvOnStart: false, spin: {} as { model: 'opus' } }
			const result = settingsManager.getSpinModel(settings)
			expect(result).toBe('opus')
		})

		it('should return spin.swarmModel when mode is swarm and swarmModel is set', () => {
			const settings = { sourceEnvOnStart: false, spin: { model: 'opus' as const, swarmModel: 'sonnet' as const } }
			const result = settingsManager.getSpinModel(settings as unknown as IloomSettings, 'swarm')
			expect(result).toBe('sonnet')
		})

		it('should default to sonnet when mode is swarm but swarmModel is not set', () => {
			const settings = { sourceEnvOnStart: false, spin: { model: 'haiku' as const } }
			const result = settingsManager.getSpinModel(settings as unknown as IloomSettings, 'swarm')
			expect(result).toBe('sonnet')
		})

		it('should ignore swarmModel when mode is not swarm', () => {
			const settings = { sourceEnvOnStart: false, spin: { model: 'opus' as const, swarmModel: 'sonnet' as const } }
			const result = settingsManager.getSpinModel(settings as unknown as IloomSettings)
			expect(result).toBe('opus')
		})

		it('swarm mode defaults to sonnet even when spin.model is opus', () => {
			const settings = { sourceEnvOnStart: false, spin: { model: 'opus' as const } }
			const result = settingsManager.getSpinModel(settings as unknown as IloomSettings, 'swarm')
			expect(result).toBe('sonnet')
		})

		it('swarm mode defaults to sonnet even when spin.model is haiku', () => {
			const settings = { sourceEnvOnStart: false, spin: { model: 'haiku' as const } }
			const result = settingsManager.getSpinModel(settings as unknown as IloomSettings, 'swarm')
			expect(result).toBe('sonnet')
		})

		it('swarm mode defaults to sonnet even when no spin config exists', () => {
			const settings = { sourceEnvOnStart: false }
			const result = settingsManager.getSpinModel(settings as unknown as IloomSettings, 'swarm')
			expect(result).toBe('sonnet')
		})

		it('explicit spin.swarmModel overrides the default in swarm mode', () => {
			const settings = { sourceEnvOnStart: false, spin: { model: 'sonnet' as const, swarmModel: 'opus' as const } }
			const result = settingsManager.getSpinModel(settings as unknown as IloomSettings, 'swarm')
			expect(result).toBe('opus')
		})

		it('non-swarm mode ignores swarmModel and uses spin.model', () => {
			const settings = { sourceEnvOnStart: false, spin: { model: 'haiku' as const, swarmModel: 'opus' as const } }
			const result = settingsManager.getSpinModel(settings as unknown as IloomSettings)
			expect(result).toBe('haiku')
		})
	})

	describe('swarmModel schema validation', () => {
		it('accepts swarmModel on BaseAgentSettingsSchema', () => {
			const result = BaseAgentSettingsSchema.safeParse({ swarmModel: 'sonnet' })
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.swarmModel).toBe('sonnet')
			}
		})

		it('accepts all valid model values for swarmModel on BaseAgentSettingsSchema', () => {
			for (const model of ['sonnet', 'opus', 'haiku'] as const) {
				const result = BaseAgentSettingsSchema.safeParse({ swarmModel: model })
				expect(result.success).toBe(true)
			}
		})

		it('rejects invalid swarmModel value on BaseAgentSettingsSchema', () => {
			const result = BaseAgentSettingsSchema.safeParse({ swarmModel: 'invalid' })
			expect(result.success).toBe(false)
		})

		it('accepts swarmModel on SpinAgentSettingsSchema', () => {
			const result = SpinAgentSettingsSchema.safeParse({ swarmModel: 'sonnet' })
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.swarmModel).toBe('sonnet')
			}
		})

		it('accepts SpinAgentSettingsSchema with both model and swarmModel', () => {
			const result = SpinAgentSettingsSchema.safeParse({ model: 'opus', swarmModel: 'sonnet' })
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.model).toBe('opus')
				expect(result.data.swarmModel).toBe('sonnet')
			}
		})
	})

	describe('getPlanPlanner', () => {
		it('should return claude by default when plan not configured', () => {
			const settings = { sourceEnvOnStart: false }
			const result = settingsManager.getPlanPlanner(settings)
			expect(result).toBe('claude')
		})

		it('should return configured planner when plan.planner is set to gemini', () => {
			const settings = { sourceEnvOnStart: false, plan: { planner: 'gemini' as const } }
			const result = settingsManager.getPlanPlanner(settings)
			expect(result).toBe('gemini')
		})

		it('should return configured planner when plan.planner is set to codex', () => {
			const settings = { sourceEnvOnStart: false, plan: { planner: 'codex' as const } }
			const result = settingsManager.getPlanPlanner(settings)
			expect(result).toBe('codex')
		})

		it('should return configured planner when plan.planner is set to claude', () => {
			const settings = { sourceEnvOnStart: false, plan: { planner: 'claude' as const } }
			const result = settingsManager.getPlanPlanner(settings)
			expect(result).toBe('claude')
		})

		it('should return claude when plan object exists but planner not set', () => {
			const settings = { sourceEnvOnStart: false, plan: { model: 'opus' as const } }
			const result = settingsManager.getPlanPlanner(settings)
			expect(result).toBe('claude')
		})
	})

	describe('mergeBehavior.autoCommitPush', () => {
		it('should accept boolean true for autoCommitPush', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mergeBehavior: {
					mode: 'github-draft-pr' as const,
					autoCommitPush: true,
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.mergeBehavior?.autoCommitPush).toBe(true)
		})

		it('should accept boolean false for autoCommitPush', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mergeBehavior: {
					mode: 'github-draft-pr' as const,
					autoCommitPush: false,
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.mergeBehavior?.autoCommitPush).toBe(false)
		})

		it('should accept undefined for autoCommitPush (optional)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mergeBehavior: {
					mode: 'github-draft-pr' as const,
					// autoCommitPush intentionally omitted
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.mergeBehavior?.autoCommitPush).toBeUndefined()
		})
	})

	describe('getPlanReviewer', () => {
		it('should return none by default when plan not configured', () => {
			const settings = { sourceEnvOnStart: false }
			const result = settingsManager.getPlanReviewer(settings)
			expect(result).toBe('none')
		})

		it('should return configured reviewer when plan.reviewer is set to gemini', () => {
			const settings = { sourceEnvOnStart: false, plan: { reviewer: 'gemini' as const } }
			const result = settingsManager.getPlanReviewer(settings)
			expect(result).toBe('gemini')
		})

		it('should return configured reviewer when plan.reviewer is set to codex', () => {
			const settings = { sourceEnvOnStart: false, plan: { reviewer: 'codex' as const } }
			const result = settingsManager.getPlanReviewer(settings)
			expect(result).toBe('codex')
		})

		it('should return configured reviewer when plan.reviewer is set to claude', () => {
			const settings = { sourceEnvOnStart: false, plan: { reviewer: 'claude' as const } }
			const result = settingsManager.getPlanReviewer(settings)
			expect(result).toBe('claude')
		})

		it('should return configured reviewer when plan.reviewer is set to none', () => {
			const settings = { sourceEnvOnStart: false, plan: { reviewer: 'none' as const } }
			const result = settingsManager.getPlanReviewer(settings)
			expect(result).toBe('none')
		})

		it('should return none when plan object exists but reviewer not set', () => {
			const settings = { sourceEnvOnStart: false, plan: { model: 'opus' as const } }
			const result = settingsManager.getPlanReviewer(settings)
			expect(result).toBe('none')
		})
	})

	describe('AgentSettingsSchema review field', () => {
		it('should accept review: true', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-issue-enhancer': {
						review: true,
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-issue-enhancer']?.review).toBe(true)
		})

		it('should accept review: false', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-issue-enhancer': {
						review: false,
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-issue-enhancer']?.review).toBe(false)
		})

		it('should default review to undefined when omitted (defaults to false at runtime)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-issue-enhancer': {
						model: 'sonnet',
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			// review is undefined in schema (defaults to false at runtime)
			expect(result.agents?.['iloom-issue-enhancer']?.review).toBeUndefined()
		})

		it('should coexist with other fields (model, enabled, providers)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-issue-planner': {
						model: 'opus',
						enabled: true,
						providers: {
							claude: 'sonnet',
						},
						review: true,
					},
				},
			}
			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
			.mockRejectedValueOnce(error) // global settings
			.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
			.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-issue-planner']?.model).toBe('opus')
			expect(result.agents?.['iloom-issue-planner']?.enabled).toBe(true)
			expect(result.agents?.['iloom-issue-planner']?.providers?.claude).toBe('sonnet')
			expect(result.agents?.['iloom-issue-planner']?.review).toBe(true)
		})
	})

	describe('git.commitTimeout configuration', () => {
		it('should return undefined git section when not specified in settings', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)

			// git section is optional, so it should be undefined when not provided
			expect(result.git).toEqual(defaultSettings.git)
		})

		it('should apply default commitTimeout value (60000) when git section exists but commitTimeout not specified', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				...defaultSettings
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)

			// Default should be applied by Zod schema when git object exists
			expect(result.git?.commitTimeout).toBe(60000)
		})

		it('should accept custom commitTimeout value', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				git: {
					commitTimeout: 120000,
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)

			expect(result.git?.commitTimeout).toBe(120000)
		})

		it('should reject commitTimeout below minimum (1000ms)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				git: {
					commitTimeout: 500, // Below minimum
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Commit timeout must be at least 1000ms/
			)
		})

		it('should reject commitTimeout above maximum (600000ms)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				git: {
					commitTimeout: 700000, // Above maximum
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow(
				/Commit timeout cannot exceed 600000ms/
			)
		})

		it('should accept minimum valid commitTimeout (1000ms)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				git: {
					commitTimeout: 1000, // Exact minimum
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)

			expect(result.git?.commitTimeout).toBe(1000)
		})

		it('should accept maximum valid commitTimeout (600000ms)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				mainBranch: 'main',
				git: {
					commitTimeout: 600000, // Exact maximum
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)

			expect(result.git?.commitTimeout).toBe(600000)
		})
	})

	describe('AgentSettingsSchema with nested swarm agent overrides', () => {
		it('should accept agents with nested agents sub-record for swarm-worker', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-swarm-worker': {
						model: 'sonnet',
						agents: {
							'iloom-issue-implementer': { model: 'haiku' },
						},
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-swarm-worker']?.agents?.['iloom-issue-implementer']?.model).toBe('haiku')
			expect(result.agents?.['iloom-swarm-worker']?.model).toBe('sonnet')
		})

		it('should accept agents without nested agents sub-record (backward compat)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-swarm-worker': {
						model: 'opus',
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-swarm-worker']?.model).toBe('opus')
			expect(result.agents?.['iloom-swarm-worker']?.agents).toBeUndefined()
		})

		it('should validate model enum in nested agent settings', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-swarm-worker': {
						model: 'sonnet',
						agents: {
							'iloom-issue-implementer': { model: 'invalid' },
						},
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow('Settings validation failed')
		})

		it('should merge nested swarm agent overrides from local settings', async () => {
			const projectRoot = '/test/project'
			const baseSettings = {
				agents: {
					'iloom-swarm-worker': {
						model: 'sonnet',
						agents: {
							'iloom-issue-implementer': { model: 'opus' },
						},
					},
				},
			}
			const localSettings = {
				agents: {
					'iloom-swarm-worker': {
						agents: {
							'iloom-issue-implementer': { model: 'haiku' },
						},
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(baseSettings)) // settings.json
				.mockResolvedValueOnce(JSON.stringify(localSettings)) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			// Local override should win
			expect(result.agents?.['iloom-swarm-worker']?.agents?.['iloom-issue-implementer']?.model).toBe('haiku')
			// Base model should be preserved via deep merge
			expect(result.agents?.['iloom-swarm-worker']?.model).toBe('sonnet')
		})

		it('should accept multiple nested agent overrides under swarm-worker', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-swarm-worker': {
						model: 'sonnet',
						agents: {
							'iloom-issue-implementer': { model: 'haiku' },
							'iloom-issue-planner': { model: 'opus' },
						},
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-swarm-worker']?.agents?.['iloom-issue-implementer']?.model).toBe('haiku')
			expect(result.agents?.['iloom-swarm-worker']?.agents?.['iloom-issue-planner']?.model).toBe('opus')
		})
	})

	describe('AgentSettingsSchema subAgentTimeout', () => {
		it('should accept valid subAgentTimeout on swarm-worker', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-swarm-worker': {
						model: 'sonnet',
						subAgentTimeout: 30,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-swarm-worker']?.subAgentTimeout).toBe(30)
		})

		it('should accept subAgentTimeout of 1 minute (minimum)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-swarm-worker': {
						subAgentTimeout: 1,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-swarm-worker']?.subAgentTimeout).toBe(1)
		})

		it('should accept subAgentTimeout of 120 minutes (maximum)', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-swarm-worker': {
						subAgentTimeout: 120,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-swarm-worker']?.subAgentTimeout).toBe(120)
		})

		it('should reject subAgentTimeout below 1 minute', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-swarm-worker': {
						subAgentTimeout: 0,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow('Settings validation failed')
		})

		it('should reject subAgentTimeout above 120 minutes', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-swarm-worker': {
						subAgentTimeout: 121,
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			await expect(settingsManager.loadSettings(projectRoot)).rejects.toThrow('Settings validation failed')
		})

		it('should leave subAgentTimeout undefined when not configured', async () => {
			const projectRoot = '/test/project'
			const settings = {
				agents: {
					'iloom-swarm-worker': {
						model: 'sonnet',
					},
				},
			}

			const error: { code?: string; message: string } = {
				code: 'ENOENT',
				message: 'ENOENT: no such file or directory',
			}

			vi.mocked(readFile)
				.mockRejectedValueOnce(error) // global settings
				.mockResolvedValueOnce(JSON.stringify(settings)) // settings.json
				.mockRejectedValueOnce(error) // settings.local.json

			const result = await settingsManager.loadSettings(projectRoot)
			expect(result.agents?.['iloom-swarm-worker']?.subAgentTimeout).toBeUndefined()
		})
	})
})
