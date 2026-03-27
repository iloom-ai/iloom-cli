import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProjectCapabilityDetector } from './ProjectCapabilityDetector.js'
import * as packageJsonUtils from '../utils/package-json.js'
import type { PackageJson } from '../utils/package-json.js'
import fs from 'fs-extra'

vi.mock('../utils/package-json.js', () => ({
  getPackageConfig: vi.fn(),
  parseBinField: vi.fn(),
  hasWebDependencies: vi.fn(),
  hasIosDependencies: vi.fn(),
  getExplicitCapabilities: vi.fn()
}))

vi.mock('fs-extra', () => ({
  default: {
    readdir: vi.fn(),
    pathExists: vi.fn(),
    readJson: vi.fn(),
  }
}))

vi.mock('../utils/logger-context.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }))
}))

describe('ProjectCapabilityDetector', () => {
  let detector: ProjectCapabilityDetector

  beforeEach(() => {
    detector = new ProjectCapabilityDetector()
    // Default: no explicit capabilities (fallback to package.json detection)
    vi.mocked(packageJsonUtils.getExplicitCapabilities).mockReturnValue([])
    // Default: no iOS dependencies
    vi.mocked(packageJsonUtils.hasIosDependencies).mockReturnValue(false)
    // Default: no iOS filesystem markers
    vi.mocked(fs.readdir).mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fs.readdir>>)
    vi.mocked(fs.pathExists).mockResolvedValue(false as never)
    vi.mocked(fs.readJson).mockResolvedValue({})
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

  describe('iOS detection', () => {
    describe('dependency-based detection', () => {
      it('should detect iOS capability from react-native dependency', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-rn-app',
          dependencies: { 'react-native': '^0.73.0' }
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        vi.mocked(packageJsonUtils.hasIosDependencies).mockReturnValueOnce(true)
        vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({})

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toContain('ios')
      })

      it('should detect iOS capability from expo dependency', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-expo-app',
          dependencies: { expo: '^50.0.0' }
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        vi.mocked(packageJsonUtils.hasIosDependencies).mockReturnValueOnce(true)
        vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({})

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toContain('ios')
      })

      it('should detect hybrid web + iOS from React Native project with web deps', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-rn-web-app',
          dependencies: {
            'react-native': '^0.73.0',
            'react-native-web': '^0.19.0',
            next: '^14.0.0'
          }
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(true)
        vi.mocked(packageJsonUtils.hasIosDependencies).mockReturnValueOnce(true)
        vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({})

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toContain('web')
        expect(result.capabilities).toContain('ios')
      })
    })

    describe('filesystem-based detection', () => {
      it('should detect iOS from .xcodeproj file in root', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-app',
          dependencies: {}
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        // First readdir call: root dir. pathExists for ios/ returns false (default), so no second readdir.
        vi.mocked(fs.readdir).mockResolvedValueOnce(['MyApp.xcodeproj', 'src'] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toContain('ios')
      })

      it('should detect iOS from .xcworkspace file in root', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-app',
          dependencies: {}
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        vi.mocked(fs.readdir).mockResolvedValueOnce(['MyApp.xcworkspace', 'Pods'] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toContain('ios')
      })

      it('should detect iOS from .xcodeproj file in ios/ subdirectory', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-rn-app',
          dependencies: {}
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        // root has no Xcode files; ios/ subdir exists and has .xcodeproj
        vi.mocked(fs.readdir).mockResolvedValueOnce([] as unknown as Awaited<ReturnType<typeof fs.readdir>>) // root
        vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
          return (p as string).endsWith('/ios')
        })
        vi.mocked(fs.readdir).mockResolvedValueOnce(['MyRNApp.xcodeproj'] as unknown as Awaited<ReturnType<typeof fs.readdir>>) // ios/

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toContain('ios')
      })

      it('should detect iOS from Podfile in root', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-app',
          dependencies: {}
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
          return p.endsWith('/Podfile') && !p.includes('/ios/')
        })

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toContain('ios')
      })

      it('should detect iOS from Podfile in ios/ subdirectory', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-app',
          dependencies: {}
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
          return (p as string).endsWith('/ios/Podfile')
        })

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toContain('ios')
      })

      it('should detect iOS from app.json with expo key (Expo)', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-app',
          dependencies: {}
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
          return (p as string).endsWith('/app.json')
        })
        vi.mocked(fs.readJson).mockResolvedValueOnce({ expo: { name: 'my-app', slug: 'my-app' } })

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toContain('ios')
      })

      it('should NOT detect iOS from generic app.json without expo or ios keys', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-node-app',
          dependencies: {}
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
          return (p as string).endsWith('/app.json')
        })
        vi.mocked(fs.readJson).mockResolvedValueOnce({ name: 'my-app', scripts: {} })

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).not.toContain('ios')
      })

      it('should detect iOS from app.config.js in root (Expo)', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-app',
          dependencies: {}
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
          return (p as string).endsWith('/app.config.js')
        })

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toContain('ios')
      })
    })

    describe('platform guard', () => {
      it('should skip iOS detection on linux and log debug message', async () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
        try {
          const mockPackageJson: PackageJson = {
            name: 'my-rn-app',
            dependencies: { 'react-native': '^0.73.0' }
          }

          vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
          vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
          vi.mocked(packageJsonUtils.hasIosDependencies).mockReturnValueOnce(true)
          vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({})

          const result = await detector.detectCapabilities('/test/path')

          expect(result.capabilities).not.toContain('ios')
        } finally {
          Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
        }
      })

      it('should skip iOS detection on win32 and log debug message', async () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
        try {
          const mockPackageJson: PackageJson = {
            name: 'my-rn-app',
            dependencies: { 'react-native': '^0.73.0' }
          }

          vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
          vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
          vi.mocked(packageJsonUtils.hasIosDependencies).mockReturnValueOnce(true)
          vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({})

          const result = await detector.detectCapabilities('/test/path')

          expect(result.capabilities).not.toContain('ios')
        } finally {
          Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
        }
      })

      it('should detect iOS on darwin', async () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
        try {
          const mockPackageJson: PackageJson = {
            name: 'my-rn-app',
            dependencies: { 'react-native': '^0.73.0' }
          }

          vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
          vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
          vi.mocked(packageJsonUtils.hasIosDependencies).mockReturnValueOnce(true)
          vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({})

          const result = await detector.detectCapabilities('/test/path')

          expect(result.capabilities).toContain('ios')
        } finally {
          Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
        }
      })
    })

    describe('combined detection', () => {
      it('should not duplicate ios capability when multiple markers present', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-rn-app',
          dependencies: { 'react-native': '^0.73.0' }
        }

        // Both dependency-based and filesystem-based markers present
        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(false)
        vi.mocked(packageJsonUtils.hasIosDependencies).mockReturnValueOnce(true)
        // The detector returns early from dependency check, so filesystem won't be checked
        vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({})

        const result = await detector.detectCapabilities('/test/path')

        const iosCount = result.capabilities.filter(c => c === 'ios').length
        expect(iosCount).toBe(1)
      })

      it('should return cli + web + ios for a full-stack RN project with bin', async () => {
        const mockPackageJson: PackageJson = {
          name: 'my-full-stack',
          bin: './dist/cli.js',
          dependencies: {
            'react-native': '^0.73.0',
            next: '^14.0.0'
          }
        }

        vi.mocked(packageJsonUtils.getPackageConfig).mockResolvedValueOnce(mockPackageJson)
        vi.mocked(packageJsonUtils.hasWebDependencies).mockReturnValueOnce(true)
        vi.mocked(packageJsonUtils.hasIosDependencies).mockReturnValueOnce(true)
        vi.mocked(packageJsonUtils.parseBinField).mockReturnValueOnce({
          'my-full-stack': './dist/cli.js'
        })

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toEqual(['cli', 'web', 'ios'])
      })

      it('should return empty capabilities when no package.json and no iOS markers on darwin', async () => {
        const error = new Error('package.json not found in /test/path')
        vi.mocked(packageJsonUtils.getPackageConfig).mockRejectedValueOnce(error)

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toEqual([])
        expect(result.binEntries).toEqual({})
      })

      it('should detect iOS from filesystem when package.json is missing on darwin', async () => {
        const error = new Error('package.json not found in /test/path')
        vi.mocked(packageJsonUtils.getPackageConfig).mockRejectedValueOnce(error)
        vi.mocked(fs.readdir).mockResolvedValueOnce(['MyApp.xcodeproj'] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

        const result = await detector.detectCapabilities('/test/path')

        expect(result.capabilities).toEqual(['ios'])
        expect(result.binEntries).toEqual({})
      })
    })
  })
})
