import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProjectCapabilityDetector } from './ProjectCapabilityDetector.js'
import * as packageJsonUtils from '../utils/package-json.js'
import type { PackageJson } from '../utils/package-json.js'
import fs from 'fs-extra'

vi.mock('../utils/package-json.js', () => ({
  getPackageConfig: vi.fn(),
  parseBinField: vi.fn(),
  hasWebDependencies: vi.fn(),
  getExplicitCapabilities: vi.fn()
}))

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn()
  }
}))

describe('ProjectCapabilityDetector', () => {
  let detector: ProjectCapabilityDetector

  beforeEach(() => {
    vi.clearAllMocks()
    detector = new ProjectCapabilityDetector()
    // Default: no explicit capabilities (fallback to package.json detection)
    vi.mocked(packageJsonUtils.getExplicitCapabilities).mockReturnValue([])
    // Default: no pnpm-workspace.yaml
    vi.mocked(fs.pathExists as (path: string) => Promise<boolean>).mockResolvedValue(false)
  })

  describe('detectCapabilities', () => {
    it('should detect CLI-only project (iloom itself)', async () => {
      const mockPackageJson: PackageJson = {
        name: 'iloom-ai',
        bin: {
          il: './dist/cli.js',
          iloom: './dist/cli.js'
        },
        dependencies: {
          commander: '^11.0.0'
        }
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({
        il: './dist/cli.js',
        iloom: './dist/cli.js'
      })

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual(['cli'])
      expect(result.binEntries).toEqual({
        il: './dist/cli.js',
        iloom: './dist/cli.js'
      })
      expect(packageJsonUtils.getPackageConfig).toHaveBeenCalledWith('/test/path')
      expect(packageJsonUtils.parseBinField).toHaveBeenCalledWith(
        mockPackageJson.bin,
        'iloom-ai'
      )
    })

    it('should detect web-only project (Next.js app)', async () => {
      const mockPackageJson: PackageJson = {
        name: 'my-nextjs-app',
        dependencies: {
          next: '^14.0.0',
          react: '^18.0.0'
        }
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(true)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({})

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual(['web'])
      expect(result.binEntries).toEqual({})
    })

    it('should detect hybrid project (CLI with web dashboard)', async () => {
      const mockPackageJson: PackageJson = {
        name: 'hybrid-tool',
        bin: './dist/cli.js',
        dependencies: {
          express: '^4.18.0'
        }
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(true)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({
        'hybrid-tool': './dist/cli.js'
      })

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual(['cli', 'web'])
      expect(result.binEntries).toEqual({
        'hybrid-tool': './dist/cli.js'
      })
    })

    it('should detect project with no capabilities', async () => {
      const mockPackageJson: PackageJson = {
        name: 'library-package',
        dependencies: {
          lodash: '^4.17.21'
        }
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({})

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual([])
      expect(result.binEntries).toEqual({})
    })

    it('should parse bin entries correctly for CLI projects', async () => {
      const mockPackageJson: PackageJson = {
        name: 'my-cli',
        bin: {
          'my-cli': './bin/cli.js',
          'my-cli-dev': './bin/dev.js'
        }
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({
        'my-cli': './bin/cli.js',
        'my-cli-dev': './bin/dev.js'
      })

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual(['cli'])
      expect(result.binEntries).toEqual({
        'my-cli': './bin/cli.js',
        'my-cli-dev': './bin/dev.js'
      })
      expect(packageJsonUtils.parseBinField).toHaveBeenCalledWith(
        mockPackageJson.bin,
        'my-cli'
      )
    })

    it('should return empty capabilities when package.json does not exist', async () => {
      const error = new Error('package.json not found in /test/path')
      vi.mocked(packageJsonUtils.getPackageConfig).mockRejectedValueOnce(error)

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual([])
      expect(result.binEntries).toEqual({})
      expect(packageJsonUtils.getPackageConfig).toHaveBeenCalledWith('/test/path')
    })

    it('should re-throw non-ENOENT errors', async () => {
      const error = new Error('Invalid JSON in package.json')
      vi.mocked(packageJsonUtils.getPackageConfig).mockRejectedValueOnce(error)

      await expect(detector.detectCapabilities('/test/path')).rejects.toThrow('Invalid JSON in package.json')
    })
  })

  describe('parseBinEntries', () => {
    it('should parse string bin field using package name', async () => {
      const mockPackageJson: PackageJson = {
        name: 'simple-cli',
        bin: './index.js'
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({
        'simple-cli': './index.js'
      })

      const result = await detector.detectCapabilities('/test/path')

      expect(result.binEntries).toEqual({
        'simple-cli': './index.js'
      })
      expect(packageJsonUtils.parseBinField).toHaveBeenCalledWith(
        './index.js',
        'simple-cli'
      )
    })

    it('should parse object bin field with multiple binaries', async () => {
      const mockPackageJson: PackageJson = {
        name: 'multi-bin',
        bin: {
          cmd1: './bin/cmd1.js',
          cmd2: './bin/cmd2.js'
        }
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({
        cmd1: './bin/cmd1.js',
        cmd2: './bin/cmd2.js'
      })

      const result = await detector.detectCapabilities('/test/path')

      expect(result.binEntries).toEqual({
        cmd1: './bin/cmd1.js',
        cmd2: './bin/cmd2.js'
      })
    })

    it('should handle packages with special characters in name', async () => {
      const mockPackageJson: PackageJson = {
        name: '@scope/my-cli',
        bin: './cli.js'
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({
        '@scope/my-cli': './cli.js'
      })

      const result = await detector.detectCapabilities('/test/path')

      expect(result.binEntries).toEqual({
        '@scope/my-cli': './cli.js'
      })
      expect(packageJsonUtils.parseBinField).toHaveBeenCalledWith(
        './cli.js',
        '@scope/my-cli'
      )
    })
  })

  describe('detectCapabilities with package.iloom.json', () => {
    it('should detect capabilities from package.iloom.json when present', async () => {
      const mockIloomPackage: PackageJson = {
        name: 'my-rust-cli',
        capabilities: ['cli'],
        scripts: { build: 'cargo build' }
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockIloomPackage)
      vi.mocked(packageJsonUtils.getExplicitCapabilities).mockReturnValueOnce(['cli'])

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual(['cli'])
      expect(result.binEntries).toEqual({})
      expect(packageJsonUtils.getExplicitCapabilities).toHaveBeenCalledWith(mockIloomPackage)
      // Should not call package.json detection methods
      expect(packageJsonUtils.hasWebDependencies).not.toHaveBeenCalled()
      expect(packageJsonUtils.parseBinField).not.toHaveBeenCalled()
    })

    it('should detect multiple capabilities from package.iloom.json', async () => {
      const mockIloomPackage: PackageJson = {
        name: 'my-fullstack-app',
        capabilities: ['cli', 'web'],
        scripts: { build: 'cargo build', dev: 'cargo run' }
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockIloomPackage)
      vi.mocked(packageJsonUtils.getExplicitCapabilities).mockReturnValueOnce(['cli', 'web'])

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual(['cli', 'web'])
      expect(result.binEntries).toEqual({})
    })

    it('should fall back to package.json detection when no capabilities in iloom config', async () => {
      const mockPackageJson: PackageJson = {
        name: 'hybrid-project',
        bin: './dist/cli.js',
        scripts: { build: 'cargo build' }  // iloom scripts but no capabilities
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.getExplicitCapabilities).mockReturnValueOnce([])
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({
        'hybrid-project': './dist/cli.js'
      })

      const result = await detector.detectCapabilities('/test/path')

      // Falls back to package.json bin detection
      expect(result.capabilities).toEqual(['cli'])
      expect(result.binEntries).toEqual({ 'hybrid-project': './dist/cli.js' })
      expect(packageJsonUtils.hasWebDependencies).toHaveBeenCalled()
      expect(packageJsonUtils.parseBinField).toHaveBeenCalled()
    })

    it('should return empty binEntries for non-Node.js projects with explicit capabilities', async () => {
      const mockIloomPackage: PackageJson = {
        name: 'my-rust-cli',
        capabilities: ['cli'],
        scripts: { build: 'cargo build' }
        // No package.json bin field - this is a pure Rust project
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockIloomPackage)
      vi.mocked(packageJsonUtils.getExplicitCapabilities).mockReturnValueOnce(['cli'])

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual(['cli'])
      expect(result.binEntries).toEqual({})
      // parseBinField should NOT be called for explicit capabilities
      expect(packageJsonUtils.parseBinField).not.toHaveBeenCalled()
    })

    it('should detect web capability from package.iloom.json for Python web apps', async () => {
      const mockIloomPackage: PackageJson = {
        name: 'my-django-app',
        capabilities: ['web'],
        scripts: { dev: 'python manage.py runserver' }
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockIloomPackage)
      vi.mocked(packageJsonUtils.getExplicitCapabilities).mockReturnValueOnce(['web'])

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual(['web'])
      expect(result.binEntries).toEqual({})
    })
  })

  describe('monorepo detection', () => {
    it('should detect monorepo from pnpm-workspace.yaml', async () => {
      const mockPackageJson: PackageJson = {
        name: 'my-monorepo',
        dependencies: {}
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      vi.mocked(fs.pathExists as (path: string) => Promise<boolean>).mockResolvedValue(true)

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toContain('monorepo')
      expect(result.capabilities).not.toContain('cli')
      expect(result.capabilities).not.toContain('web')
    })

    it('should detect monorepo from package.json workspaces field (array)', async () => {
      const mockPackageJson: PackageJson = {
        name: 'my-monorepo',
        workspaces: ['packages/*'],
        dependencies: {}
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      // pathExists returns false (no pnpm-workspace.yaml), falls through to workspaces check

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toContain('monorepo')
    })

    it('should detect monorepo from package.json workspaces field (object form)', async () => {
      const mockPackageJson: PackageJson = {
        name: 'my-monorepo',
        workspaces: { packages: ['packages/*'] },
        dependencies: {}
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toContain('monorepo')
    })

    it('should combine monorepo with cli capability', async () => {
      const mockPackageJson: PackageJson = {
        name: 'my-monorepo-cli',
        bin: { 'my-cli': './dist/cli.js' },
        dependencies: {}
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({ 'my-cli': './dist/cli.js' })
      vi.mocked(fs.pathExists as (path: string) => Promise<boolean>).mockResolvedValue(true)

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toContain('cli')
      expect(result.capabilities).toContain('monorepo')
    })

    it('should detect monorepo from explicit capabilities in package.iloom.json', async () => {
      const mockIloomPackage: PackageJson = {
        name: 'my-monorepo',
        capabilities: ['monorepo', 'web']
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockIloomPackage)
      vi.mocked(packageJsonUtils.getExplicitCapabilities).mockReturnValueOnce(['monorepo', 'web'])

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual(['monorepo', 'web'])
      expect(result.binEntries).toEqual({})
    })

    it('should not set monorepo capability when no workspace markers exist', async () => {
      const mockPackageJson: PackageJson = {
        name: 'regular-cli',
        bin: { 'regular-cli': './dist/cli.js' },
        dependencies: {}
      }

      vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
      vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
      vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({ 'regular-cli': './dist/cli.js' })
      // pathExists returns false (default) and no workspaces field

      const result = await detector.detectCapabilities('/test/path')

      expect(result.capabilities).toEqual(['cli'])
      expect(result.capabilities).not.toContain('monorepo')
    })
  })
})
