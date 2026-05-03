import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs-extra'
import {
  readPackageJson,
  parseBinField,
  hasWebDependencies,
  hasScript,
  readIloomPackageScripts,
  getPackageConfig,
  getPackageScripts,
  getExplicitCapabilities,
  ILOOM_PACKAGE_PATH,
  ILOOM_PACKAGE_LOCAL_PATH
} from './package-json.js'
import type { PackageJson } from './package-json.js'

vi.mock('fs-extra')
vi.mock('./logger-context.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn()
  })
}))

describe('readPackageJson', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should read and parse package.json successfully', async () => {
    const mockPackageJson: PackageJson = {
      name: 'test-package',
      version: '1.0.0',
      bin: './dist/cli.js',
      scripts: {
        build: 'tsc',
        test: 'vitest'
      }
    }

    vi.mocked(fs.readJson).mockResolvedValueOnce(mockPackageJson)

    const result = await readPackageJson('/test/path')

    expect(fs.readJson).toHaveBeenCalledWith('/test/path/package.json')
    expect(result).toEqual(mockPackageJson)
  })

  it('should throw error if package.json does not exist', async () => {
    vi.mocked(fs.readJson).mockRejectedValueOnce({ code: 'ENOENT' })

    await expect(readPackageJson('/test/path')).rejects.toThrow(
      'package.json not found in /test/path'
    )
  })

  it('should throw error if package.json has invalid JSON', async () => {
    vi.mocked(fs.readJson).mockRejectedValueOnce(
      new Error('Unexpected token } in JSON')
    )

    await expect(readPackageJson('/test/path')).rejects.toThrow(
      'Invalid package.json in /test/path: Unexpected token } in JSON'
    )
  })

  it('should handle package.json without bin field', async () => {
    const mockPackageJson: PackageJson = {
      name: 'web-app',
      version: '1.0.0',
      dependencies: {
        next: '^14.0.0'
      }
    }

    vi.mocked(fs.readJson).mockResolvedValueOnce(mockPackageJson)

    const result = await readPackageJson('/test/path')

    expect(result.bin).toBeUndefined()
    expect(result).toEqual(mockPackageJson)
  })
})

describe('parseBinField', () => {
  it('should parse object bin field with multiple entries', () => {
    const binField = {
      il: './dist/cli.js',
      iloom: './dist/cli.js'
    }

    const result = parseBinField(binField, 'iloom-ai')

    expect(result).toEqual({
      il: './dist/cli.js',
      iloom: './dist/cli.js'
    })
  })

  it('should parse string bin field and use package name', () => {
    const binField = './dist/cli.js'

    const result = parseBinField(binField, 'my-cli-tool')

    expect(result).toEqual({
      'my-cli-tool': './dist/cli.js'
    })
  })

  it('should return empty object for undefined bin field', () => {
    const result = parseBinField(undefined, 'some-package')

    expect(result).toEqual({})
  })

  it('should handle bin field pointing to non-existent files', () => {
    // parseBinField just parses the structure, doesn't verify files exist
    const binField = './non-existent.js'

    const result = parseBinField(binField, 'test-pkg')

    expect(result).toEqual({
      'test-pkg': './non-existent.js'
    })
  })
})

describe('hasWebDependencies', () => {
  it('should detect Next.js in dependencies', () => {
    const pkgJson: PackageJson = {
      name: 'web-app',
      dependencies: {
        next: '^14.0.0',
        react: '^18.0.0'
      }
    }

    expect(hasWebDependencies(pkgJson)).toBe(true)
  })

  it('should detect Vite in devDependencies', () => {
    const pkgJson: PackageJson = {
      name: 'vite-app',
      devDependencies: {
        vite: '^5.0.0'
      }
    }

    expect(hasWebDependencies(pkgJson)).toBe(true)
  })

  it('should detect Express, Fastify, Koa in dependencies', () => {
    const expressApp: PackageJson = {
      name: 'express-app',
      dependencies: {
        express: '^4.18.0'
      }
    }

    const fastifyApp: PackageJson = {
      name: 'fastify-app',
      dependencies: {
        fastify: '^4.0.0'
      }
    }

    const koaApp: PackageJson = {
      name: 'koa-app',
      dependencies: {
        koa: '^2.14.0'
      }
    }

    expect(hasWebDependencies(expressApp)).toBe(true)
    expect(hasWebDependencies(fastifyApp)).toBe(true)
    expect(hasWebDependencies(koaApp)).toBe(true)
  })

  it('should detect Svelte, Nuxt, Remix, Astro', () => {
    const svelteApp: PackageJson = {
      name: 'svelte-app',
      devDependencies: {
        'svelte-kit': '^2.0.0'
      }
    }

    const nuxtApp: PackageJson = {
      name: 'nuxt-app',
      dependencies: {
        nuxt: '^3.0.0'
      }
    }

    const remixApp: PackageJson = {
      name: 'remix-app',
      dependencies: {
        remix: '^2.0.0'
      }
    }

    const astroApp: PackageJson = {
      name: 'astro-app',
      devDependencies: {
        astro: '^4.0.0'
      }
    }

    expect(hasWebDependencies(svelteApp)).toBe(true)
    expect(hasWebDependencies(nuxtApp)).toBe(true)
    expect(hasWebDependencies(remixApp)).toBe(true)
    expect(hasWebDependencies(astroApp)).toBe(true)
  })

  it('should return false for CLI-only projects', () => {
    const cliApp: PackageJson = {
      name: 'cli-tool',
      bin: './dist/cli.js',
      dependencies: {
        commander: '^11.0.0',
        chalk: '^5.0.0'
      }
    }

    expect(hasWebDependencies(cliApp)).toBe(false)
  })

  it('should check both dependencies and devDependencies', () => {
    const mixedApp: PackageJson = {
      name: 'mixed-app',
      dependencies: {
        lodash: '^4.17.21'
      },
      devDependencies: {
        vite: '^5.0.0'
      }
    }

    expect(hasWebDependencies(mixedApp)).toBe(true)
  })
})

describe('hasScript', () => {
  it('should return true when script exists', () => {
    const pkgJson: PackageJson = {
      name: 'test-pkg',
      scripts: {
        build: 'tsc',
        test: 'vitest',
        dev: 'tsup --watch'
      }
    }

    expect(hasScript(pkgJson, 'build')).toBe(true)
    expect(hasScript(pkgJson, 'test')).toBe(true)
    expect(hasScript(pkgJson, 'dev')).toBe(true)
  })

  it('should return false when script does not exist', () => {
    const pkgJson: PackageJson = {
      name: 'test-pkg',
      scripts: {
        build: 'tsc'
      }
    }

    expect(hasScript(pkgJson, 'deploy')).toBe(false)
    expect(hasScript(pkgJson, 'unknown')).toBe(false)
  })

  it('should return false when scripts field is undefined', () => {
    const pkgJson: PackageJson = {
      name: 'test-pkg'
    }

    expect(hasScript(pkgJson, 'build')).toBe(false)
  })

  it('should return false when scripts field is empty object', () => {
    const pkgJson: PackageJson = {
      name: 'test-pkg',
      scripts: {}
    }

    expect(hasScript(pkgJson, 'build')).toBe(false)
  })
})

describe('ILOOM_PACKAGE_PATH', () => {
  it('should have correct path value', () => {
    expect(ILOOM_PACKAGE_PATH).toBe('.iloom/package.iloom.json')
  })
})

describe('ILOOM_PACKAGE_LOCAL_PATH', () => {
  it('should have correct path value', () => {
    expect(ILOOM_PACKAGE_LOCAL_PATH).toBe('.iloom/package.iloom.local.json')
  })
})

describe('readIloomPackageScripts', () => {
  it('should return null when neither base nor local file exists', async () => {
    vi.mocked(fs.pathExists).mockResolvedValue(false)

    const result = await readIloomPackageScripts('/test/path')

    expect(result).toBeNull()
    expect(fs.pathExists).toHaveBeenCalledWith('/test/path/.iloom/package.iloom.json')
    expect(fs.pathExists).toHaveBeenCalledWith('/test/path/.iloom/package.iloom.local.json')
  })

  it('should read and return scripts from package.iloom.json when only base exists', async () => {
    const mockIloomPackage = {
      name: 'my-rust-project',
      scripts: {
        build: 'cargo build',
        test: 'cargo test',
        dev: 'cargo run',
      },
    }
    // Base exists, local does not
    vi.mocked(fs.pathExists)
      .mockResolvedValueOnce(true)  // base exists
      .mockResolvedValueOnce(false) // local does not exist
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockIloomPackage)

    const result = await readIloomPackageScripts('/test/path')

    expect(result).toEqual(mockIloomPackage)
    expect(fs.readJson).toHaveBeenCalledWith('/test/path/.iloom/package.iloom.json')
  })

  it('should return local config when only local file exists', async () => {
    const mockLocalPackage = {
      name: 'local-override',
      scripts: {
        test: 'pytest --custom',
        dev: 'python -m myapp --debug',
      },
    }
    // Base does not exist, local exists
    vi.mocked(fs.pathExists)
      .mockResolvedValueOnce(false)  // base does not exist
      .mockResolvedValueOnce(true)   // local exists
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockLocalPackage)

    const result = await readIloomPackageScripts('/test/path')

    expect(result).toEqual(mockLocalPackage)
    expect(fs.readJson).toHaveBeenCalledWith('/test/path/.iloom/package.iloom.local.json')
  })

  it('should return merged config when both base and local exist', async () => {
    const mockBasePackage = {
      name: 'my-rust-project',
      scripts: {
        build: 'cargo build',
        test: 'cargo test',
      },
    }
    const mockLocalPackage = {
      name: 'local-override',
      scripts: {
        test: 'pytest --custom',  // Override base test
        dev: 'python -m myapp',   // Add new script
      },
    }
    // Both exist
    vi.mocked(fs.pathExists)
      .mockResolvedValueOnce(true)  // base exists
      .mockResolvedValueOnce(true)  // local exists
    vi.mocked(fs.readJson)
      .mockResolvedValueOnce(mockBasePackage)
      .mockResolvedValueOnce(mockLocalPackage)

    const result = await readIloomPackageScripts('/test/path')

    expect(result).toEqual({
      name: 'my-rust-project',  // From base
      scripts: {
        build: 'cargo build',   // From base
        test: 'pytest --custom', // Overridden by local
        dev: 'python -m myapp',  // Added by local
      },
    })
  })

  it('should merge capabilities with local taking precedence', async () => {
    const mockBasePackage = {
      name: 'my-project',
      capabilities: ['cli'] as ['cli'],
      scripts: { build: 'make' },
    }
    const mockLocalPackage = {
      name: 'local',
      capabilities: ['web'] as ['web'],
      scripts: {},
    }
    vi.mocked(fs.pathExists)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
    vi.mocked(fs.readJson)
      .mockResolvedValueOnce(mockBasePackage)
      .mockResolvedValueOnce(mockLocalPackage)

    const result = await readIloomPackageScripts('/test/path')

    expect(result?.capabilities).toEqual(['web'])  // Local replaces base
    expect(result?.scripts).toEqual({ build: 'make' })  // Scripts merged
  })

  it('should preserve base capabilities when local has none', async () => {
    const mockBasePackage = {
      name: 'my-project',
      capabilities: ['cli', 'web'] as ['cli', 'web'],
      scripts: { build: 'make' },
    }
    const mockLocalPackage = {
      name: 'local',
      scripts: { dev: 'run' },
    }
    vi.mocked(fs.pathExists)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
    vi.mocked(fs.readJson)
      .mockResolvedValueOnce(mockBasePackage)
      .mockResolvedValueOnce(mockLocalPackage)

    const result = await readIloomPackageScripts('/test/path')

    expect(result?.capabilities).toEqual(['cli', 'web'])  // From base
  })

  it('should fall back to base when local has malformed JSON', async () => {
    const mockBasePackage = {
      name: 'my-project',
      scripts: { build: 'make' },
    }
    vi.mocked(fs.pathExists)
      .mockResolvedValueOnce(true)  // base exists
      .mockResolvedValueOnce(true)  // local exists
    vi.mocked(fs.readJson)
      .mockResolvedValueOnce(mockBasePackage)
      .mockRejectedValueOnce(new Error('Invalid JSON'))

    const result = await readIloomPackageScripts('/test/path')

    expect(result).toEqual(mockBasePackage)
  })

  it('should return null and log warning when base has malformed JSON and no local', async () => {
    vi.mocked(fs.pathExists)
      .mockResolvedValueOnce(true)   // base exists
      .mockResolvedValueOnce(false)  // local does not exist
    vi.mocked(fs.readJson).mockRejectedValueOnce(new Error('Invalid JSON'))

    const result = await readIloomPackageScripts('/test/path')

    expect(result).toBeNull()
  })
})

describe('getPackageConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return package.json when package.iloom.json does not exist', async () => {
    const mockPackageJson = {
      name: 'my-node-project',
      version: '1.0.0',
      bin: './dist/cli.js',
      scripts: {
        build: 'tsc',
        test: 'vitest',
      },
    }
    vi.mocked(fs.pathExists).mockResolvedValue(false)
    vi.mocked(fs.readJson).mockResolvedValue(mockPackageJson)

    const result = await getPackageConfig('/test/path')

    expect(result).toEqual(mockPackageJson)
  })

  it('should merge scripts when both files exist', async () => {
    const mockPackageJson = {
      name: 'my-node-project',
      version: '1.0.0',
      bin: './dist/cli.js',
      dependencies: { commander: '^11.0.0' },
      scripts: {
        build: 'tsc',
        test: 'vitest',
        lint: 'eslint .',
      },
    }
    const mockIloomPackage = {
      name: 'custom',
      scripts: {
        test: 'pytest',  // Override test script
        dev: 'python -m myapp',  // Add new script
      },
    }

    // First call: pathExists for package.iloom.json
    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    // First readJson: package.iloom.json
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockIloomPackage)
    // Second readJson: package.json
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockPackageJson)

    const result = await getPackageConfig('/test/path')

    // Should have all package.json fields
    expect(result.name).toBe('my-node-project')
    expect(result.version).toBe('1.0.0')
    expect(result.bin).toBe('./dist/cli.js')
    expect(result.dependencies).toEqual({ commander: '^11.0.0' })

    // Scripts should be merged with iloom taking precedence
    expect(result.scripts).toEqual({
      build: 'tsc',       // From package.json
      test: 'pytest',     // Overridden by iloom
      lint: 'eslint .',   // From package.json
      dev: 'python -m myapp',  // Added by iloom
    })
  })

  it('should preserve all package.json fields when merging', async () => {
    const mockPackageJson = {
      name: 'my-cli',
      version: '2.0.0',
      bin: { 'my-cli': './dist/index.js' },
      dependencies: { lodash: '^4.17.21' },
      devDependencies: { typescript: '^5.0.0' },
      scripts: { build: 'tsc' },
    }
    const mockIloomPackage = {
      name: 'ignored',
      scripts: { test: 'cargo test' },
    }

    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    vi.mocked(fs.readJson)
      .mockResolvedValueOnce(mockIloomPackage)
      .mockResolvedValueOnce(mockPackageJson)

    const result = await getPackageConfig('/test/path')

    expect(result.name).toBe('my-cli')
    expect(result.version).toBe('2.0.0')
    expect(result.bin).toEqual({ 'my-cli': './dist/index.js' })
    expect(result.dependencies).toEqual({ lodash: '^4.17.21' })
    expect(result.devDependencies).toEqual({ typescript: '^5.0.0' })
    expect(result.scripts).toEqual({
      build: 'tsc',
      test: 'cargo test',
    })
  })

  it('should use only package.iloom.json when package.json does not exist', async () => {
    const mockIloomPackage = {
      name: 'my-rust-project',
      scripts: {
        build: 'cargo build',
        test: 'cargo test',
      },
    }

    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    vi.mocked(fs.readJson)
      .mockResolvedValueOnce(mockIloomPackage)
      .mockRejectedValueOnce({ code: 'ENOENT' })

    const result = await getPackageConfig('/test/path')

    expect(result).toEqual(mockIloomPackage)
  })

  it('should throw when neither file exists', async () => {
    vi.mocked(fs.pathExists).mockResolvedValueOnce(false)
    vi.mocked(fs.readJson).mockRejectedValueOnce({ code: 'ENOENT' })

    await expect(getPackageConfig('/test/path')).rejects.toThrow(
      'package.json not found in /test/path'
    )
  })

  it('should fall back to package.json when package.iloom.json is malformed', async () => {
    const mockPackageJson = {
      name: 'my-node-project',
      scripts: { build: 'tsc' },
    }

    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    vi.mocked(fs.readJson)
      .mockRejectedValueOnce(new Error('Invalid JSON'))
      .mockResolvedValueOnce(mockPackageJson)

    const result = await getPackageConfig('/test/path')

    expect(result).toEqual(mockPackageJson)
  })
})

describe('getPackageScripts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return scripts from package.json with source package-manager', async () => {
    const mockPackageJson = {
      name: 'my-node-project',
      scripts: {
        build: 'tsc',
        test: 'vitest',
      },
    }
    // First pathExists: package.json exists
    // Second pathExists: iloom config does not exist
    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockPackageJson)
    vi.mocked(fs.pathExists).mockResolvedValueOnce(false)

    const result = await getPackageScripts('/test/path')

    expect(result).toEqual({
      build: { command: 'tsc', source: 'package-manager' },
      test: { command: 'vitest', source: 'package-manager' },
    })
  })

  it('should return scripts from package.iloom.json with source iloom-config', async () => {
    const mockIloomPackage = {
      name: 'my-rust-project',
      scripts: {
        build: 'cargo build',
        test: 'cargo test',
      },
    }
    // First pathExists: package.json does not exist
    // Second pathExists: iloom config exists
    vi.mocked(fs.pathExists).mockResolvedValueOnce(false)
    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockIloomPackage)

    const result = await getPackageScripts('/test/path')

    expect(result).toEqual({
      build: { command: 'cargo build', source: 'iloom-config' },
      test: { command: 'cargo test', source: 'iloom-config' },
    })
  })

  it('should override package.json scripts with iloom scripts using correct source', async () => {
    const mockPackageJson = {
      name: 'my-project',
      scripts: {
        build: 'tsc',
        test: 'vitest',
        lint: 'eslint .',
      },
    }
    const mockIloomPackage = {
      name: 'my-project',
      scripts: {
        test: 'pytest',
        dev: 'python -m myapp',
      },
    }

    // First pathExists: package.json exists
    // Second pathExists: iloom config exists
    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockPackageJson)
    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockIloomPackage)

    const result = await getPackageScripts('/test/path')

    expect(result).toEqual({
      build: { command: 'tsc', source: 'package-manager' },
      test: { command: 'pytest', source: 'iloom-config' },
      lint: { command: 'eslint .', source: 'package-manager' },
      dev: { command: 'python -m myapp', source: 'iloom-config' },
    })
  })

  it('should return empty object when neither file exists', async () => {
    // First pathExists: package.json does not exist
    // Second pathExists: iloom config does not exist
    vi.mocked(fs.pathExists).mockResolvedValueOnce(false)
    vi.mocked(fs.pathExists).mockResolvedValueOnce(false)

    const result = await getPackageScripts('/test/path')

    expect(result).toEqual({})
  })

  it('should handle package.json without scripts field', async () => {
    const mockPackageJson = {
      name: 'my-project',
      version: '1.0.0',
    }
    // First pathExists: package.json exists
    // Second pathExists: iloom config does not exist
    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockPackageJson)
    vi.mocked(fs.pathExists).mockResolvedValueOnce(false)

    const result = await getPackageScripts('/test/path')

    expect(result).toEqual({})
  })

  it('should handle iloom package without scripts field', async () => {
    const mockPackageJson = {
      name: 'my-project',
      scripts: {
        build: 'tsc',
      },
    }
    const mockIloomPackage = {
      name: 'my-project',
    }
    // First pathExists: package.json exists
    // Second pathExists: iloom config exists
    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockPackageJson)
    vi.mocked(fs.pathExists).mockResolvedValueOnce(true)
    vi.mocked(fs.readJson).mockResolvedValueOnce(mockIloomPackage)

    const result = await getPackageScripts('/test/path')

    expect(result).toEqual({
      build: { command: 'tsc', source: 'package-manager' },
    })
  })
})

describe('getExplicitCapabilities', () => {
  it('should return capabilities array when present', () => {
    const pkgJson: PackageJson = {
      name: 'my-rust-project',
      capabilities: ['cli', 'web'],
    }

    const result = getExplicitCapabilities(pkgJson)

    expect(result).toEqual(['cli', 'web'])
  })

  it('should return empty array when capabilities not present', () => {
    const pkgJson: PackageJson = {
      name: 'my-project',
      scripts: { build: 'tsc' },
    }

    const result = getExplicitCapabilities(pkgJson)

    expect(result).toEqual([])
  })

  it('should filter invalid values from capabilities', () => {
    const pkgJson: PackageJson = {
      name: 'my-project',
      capabilities: ['cli', 'invalid' as 'cli', 'unknown' as 'cli', 'web'],
    }

    const result = getExplicitCapabilities(pkgJson)

    expect(result).toEqual(['cli', 'web'])
  })

  it('should return empty array for non-array capabilities field', () => {
    const pkgJson = {
      name: 'my-project',
      capabilities: 'cli', // string instead of array
    } as unknown as PackageJson

    const result = getExplicitCapabilities(pkgJson)

    expect(result).toEqual([])
  })

  it('should return single capability when only one is declared', () => {
    const pkgJson: PackageJson = {
      name: 'my-cli-project',
      capabilities: ['cli'],
    }

    const result = getExplicitCapabilities(pkgJson)

    expect(result).toEqual(['cli'])
  })

  it('should return empty array for empty capabilities array', () => {
    const pkgJson: PackageJson = {
      name: 'my-project',
      capabilities: [],
    }

    const result = getExplicitCapabilities(pkgJson)

    expect(result).toEqual([])
  })

  it('should accept ios as valid capability', () => {
    const pkgJson: PackageJson = {
      name: 'my-ios-project',
      capabilities: ['ios'],
    }

    const result = getExplicitCapabilities(pkgJson)

    expect(result).toEqual(['ios'])
  })

  it('should accept combination of cli, web, and ios capabilities', () => {
    const pkgJson: PackageJson = {
      name: 'my-multi-project',
      capabilities: ['cli', 'web', 'ios'],
    }

    const result = getExplicitCapabilities(pkgJson)

    expect(result).toEqual(['cli', 'web', 'ios'])
  })
})
