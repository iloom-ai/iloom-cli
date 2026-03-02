import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import type { Stats } from 'fs'
import { OpenclawCommand } from '../../src/commands/openclaw.js'

vi.mock('fs-extra')
vi.mock('../../src/utils/logger-context.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))
vi.mock('../../src/lib/TelemetryService.js', () => ({
  TelemetryService: {
    getInstance: () => ({
      track: vi.fn(),
    }),
  },
}))

const projectRoot = '/test/project'
const homeDir = os.homedir()
const openclawHome = path.join(homeDir, '.openclaw')
const defaultWorkspaceDir = path.join(openclawHome, 'workspace')
const skillsDir = path.join(defaultWorkspaceDir, 'skills')
const targetPath = path.join(skillsDir, 'iloom')
const skillSourceDir = path.join(projectRoot, 'openclaw-skill')

describe('OpenclawCommand', () => {
  let command: OpenclawCommand

  beforeEach(() => {
    command = new OpenclawCommand(projectRoot)
  })

  describe('successful linking', () => {
    it('should create symlink when everything is in place', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === defaultWorkspaceDir) return true
        if (p === targetPath) return false
        return false
      })
      vi.mocked(fs.mkdirp).mockResolvedValue(undefined)
      vi.mocked(fs.symlink).mockResolvedValue(undefined)
      vi.mocked(fs.lstat).mockRejectedValue(new Error('ENOENT'))

      const result = await command.execute()

      expect(result.status).toBe('Linked successfully')
      expect(result.source).toBe(skillSourceDir)
      expect(result.target).toBe(targetPath)
      expect(fs.symlink).toHaveBeenCalledWith(skillSourceDir, targetPath)
    })

    it('should report already linked when symlink points to correct target', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === defaultWorkspaceDir) return true
        if (p === targetPath) return true
        return false
      })
      vi.mocked(fs.mkdirp).mockResolvedValue(undefined)
      vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => true } as unknown as Stats)
      vi.mocked(fs.readlink).mockResolvedValue(skillSourceDir)

      const result = await command.execute()

      expect(result.status).toBe('Already linked')
      expect(fs.symlink).not.toHaveBeenCalled()
    })

    it('should use custom workspace when specified', async () => {
      const customWorkspaceDir = path.join(openclawHome, 'my-workspace')
      const customSkillsDir = path.join(customWorkspaceDir, 'skills')
      const customTargetPath = path.join(customSkillsDir, 'iloom')

      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === customWorkspaceDir) return true
        if (p === customTargetPath) return false
        return false
      })
      vi.mocked(fs.mkdirp).mockResolvedValue(undefined)
      vi.mocked(fs.symlink).mockResolvedValue(undefined)
      vi.mocked(fs.lstat).mockRejectedValue(new Error('ENOENT'))

      const result = await command.execute({ workspace: 'my-workspace' })

      expect(result.status).toBe('Linked successfully')
      expect(result.target).toBe(customTargetPath)
      expect(fs.mkdirp).toHaveBeenCalledWith(customSkillsDir)
    })
  })

  describe('error cases', () => {
    it('should error when openclaw-skill/ directory is missing', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return false
        return false
      })

      await expect(command.execute()).rejects.toThrow('openclaw-skill/ directory not found')
    })

    it('should error when ~/.openclaw is not installed', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return false
        return false
      })

      await expect(command.execute()).rejects.toThrow('OpenClaw is not installed (~/.openclaw not found)')
    })

    it('should error when workspace does not exist', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === defaultWorkspaceDir) return false
        return false
      })

      await expect(command.execute()).rejects.toThrow(
        "Workspace 'workspace' not found. Use --workspace <name> to specify a different workspace."
      )
    })

    it('should error when target exists as wrong symlink without --force', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === defaultWorkspaceDir) return true
        if (p === targetPath) return true
        return false
      })
      vi.mocked(fs.mkdirp).mockResolvedValue(undefined)
      vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => true } as unknown as Stats)
      vi.mocked(fs.readlink).mockResolvedValue('/some/other/path')

      await expect(command.execute()).rejects.toThrow('Use --force to overwrite')
      await expect(command.execute()).rejects.toThrow('a symlink pointing elsewhere')
    })

    it('should error when target exists as file/directory without --force', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === defaultWorkspaceDir) return true
        if (p === targetPath) return true
        return false
      })
      vi.mocked(fs.mkdirp).mockResolvedValue(undefined)
      vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => false } as unknown as Stats)

      await expect(command.execute()).rejects.toThrow('a file or directory')
    })

    it('should mention --workspace when default workspace has conflict', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === defaultWorkspaceDir) return true
        if (p === targetPath) return true
        return false
      })
      vi.mocked(fs.mkdirp).mockResolvedValue(undefined)
      vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => false } as unknown as Stats)

      await expect(command.execute()).rejects.toThrow('--workspace')
    })

    it('should not mention --workspace when custom workspace has conflict', async () => {
      const customWorkspaceDir = path.join(openclawHome, 'custom')
      const customTargetPath = path.join(customWorkspaceDir, 'skills', 'iloom')

      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === customWorkspaceDir) return true
        if (p === customTargetPath) return true
        return false
      })
      vi.mocked(fs.mkdirp).mockResolvedValue(undefined)
      vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => false } as unknown as Stats)

      try {
        await command.execute({ workspace: 'custom' })
        expect.unreachable('Should have thrown')
      } catch (error) {
        expect((error as Error).message).toContain('Use --force to overwrite')
        expect((error as Error).message).not.toContain('--workspace')
      }
    })
  })

  describe('--force flag', () => {
    it('should overwrite existing symlink with --force', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === defaultWorkspaceDir) return true
        if (p === targetPath) return true
        return false
      })
      vi.mocked(fs.mkdirp).mockResolvedValue(undefined)
      vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => true } as unknown as Stats)
      vi.mocked(fs.readlink).mockResolvedValue('/some/other/path')
      vi.mocked(fs.remove).mockResolvedValue(undefined)
      vi.mocked(fs.symlink).mockResolvedValue(undefined)

      const result = await command.execute({ force: true })

      expect(result.status).toBe('Linked successfully')
      expect(fs.remove).toHaveBeenCalledWith(targetPath)
      expect(fs.symlink).toHaveBeenCalledWith(skillSourceDir, targetPath)
    })

    it('should overwrite existing directory with --force', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === defaultWorkspaceDir) return true
        if (p === targetPath) return true
        return false
      })
      vi.mocked(fs.mkdirp).mockResolvedValue(undefined)
      vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => false } as unknown as Stats)
      vi.mocked(fs.remove).mockResolvedValue(undefined)
      vi.mocked(fs.symlink).mockResolvedValue(undefined)

      const result = await command.execute({ force: true })

      expect(result.status).toBe('Linked successfully')
      expect(fs.remove).toHaveBeenCalledWith(targetPath)
    })
  })

  describe('skills directory creation', () => {
    it('should create skills/ directory if it does not exist', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === skillSourceDir) return true
        if (p === openclawHome) return true
        if (p === defaultWorkspaceDir) return true
        if (p === targetPath) return false
        return false
      })
      vi.mocked(fs.mkdirp).mockResolvedValue(undefined)
      vi.mocked(fs.symlink).mockResolvedValue(undefined)
      vi.mocked(fs.lstat).mockRejectedValue(new Error('ENOENT'))

      await command.execute()

      expect(fs.mkdirp).toHaveBeenCalledWith(skillsDir)
    })
  })
})
