import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execa, type ExecaReturnValue, type ExecaError } from 'execa'
import { SupabaseProvider, validateSupabaseConfig } from '../../../src/lib/providers/SupabaseProvider.js'

// Mock execa for CLI command execution
vi.mock('execa')

describe('SupabaseProvider', () => {
  let provider: SupabaseProvider

  beforeEach(() => {
    provider = new SupabaseProvider({
      projectRef: 'test-project-ref',
      parentBranch: 'main',
      withData: true,
    })
  })

  describe('validateSupabaseConfig', () => {
    it('should return valid for correct config', () => {
      const result = validateSupabaseConfig({
        projectRef: 'valid-project-ref',
        parentBranch: 'main',
      })
      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('should return invalid when projectRef is missing', () => {
      const result = validateSupabaseConfig({ parentBranch: 'main' })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('projectRef is required')
    })

    it('should return invalid when parentBranch is missing', () => {
      const result = validateSupabaseConfig({ projectRef: 'test-ref' })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('parentBranch is required')
    })

    it('should return invalid when projectRef contains invalid characters', () => {
      const result = validateSupabaseConfig({
        projectRef: 'invalid_ref!@#',
        parentBranch: 'main',
      })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('invalid characters')
    })
  })

  describe('constructor / isConfigured', () => {
    it('should return true when configured with valid config', () => {
      expect(provider.isConfigured()).toBe(true)
    })

    it('should return false when projectRef is missing', () => {
      const unconfiguredProvider = new SupabaseProvider({
        projectRef: '',
        parentBranch: 'main',
      })
      expect(unconfiguredProvider.isConfigured()).toBe(false)
    })

    it('should return false when parentBranch is missing', () => {
      const unconfiguredProvider = new SupabaseProvider({
        projectRef: 'test-ref',
        parentBranch: '',
      })
      expect(unconfiguredProvider.isConfigured()).toBe(false)
    })

    it('should not throw when config is invalid (graceful degradation)', () => {
      expect(() => new SupabaseProvider({ projectRef: '', parentBranch: '' })).not.toThrow()
    })
  })

  describe('displayName and installHint', () => {
    it('should return "Supabase CLI" as displayName', () => {
      expect(provider.displayName).toBe('Supabase CLI')
    })

    it('should return install instruction as installHint', () => {
      expect(provider.installHint).toContain('supabase')
    })
  })

  describe('isCliAvailable', () => {
    it('should return true when supabase CLI is available', async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: '2.24.3', stderr: '' } as ExecaReturnValue<string>)

      const result = await provider.isCliAvailable()

      expect(result).toBe(true)
      expect(execa).toHaveBeenCalledWith('supabase', ['--version'], expect.any(Object))
    })

    it('should return false when supabase CLI is not installed (ENOENT)', async () => {
      const enoentError = Object.assign(new Error('spawn supabase ENOENT'), {
        code: 'ENOENT',
      })
      vi.mocked(execa).mockRejectedValue(enoentError)

      const result = await provider.isCliAvailable()

      expect(result).toBe(false)
    })

    it('should return true when CLI is present but version flag fails for other reasons', async () => {
      // Non-ENOENT errors mean CLI is present but something else is wrong
      const otherError = Object.assign(new Error('some other error'), {
        code: 'EPERM',
        exitCode: 1,
      })
      vi.mocked(execa).mockRejectedValue(otherError)

      const result = await provider.isCliAvailable()

      expect(result).toBe(true)
    })
  })

  describe('isAuthenticated', () => {
    it('should return true when authenticated', async () => {
      // First call: CLI available
      vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as ExecaReturnValue<string>)
      // Second call: supabase projects list succeeds
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '[{"id":"proj-123","name":"My Project"}]',
        stderr: '',
      } as ExecaReturnValue<string>)

      const result = await provider.isAuthenticated()

      expect(result).toBe(true)
      expect(execa).toHaveBeenCalledWith('supabase', ['projects', 'list'], expect.any(Object))
    })

    it('should return false when CLI not available', async () => {
      const enoentError = Object.assign(new Error('spawn supabase ENOENT'), {
        code: 'ENOENT',
      })
      vi.mocked(execa).mockRejectedValue(enoentError)

      const result = await provider.isAuthenticated()

      expect(result).toBe(false)
    })

    it('should return false when not authenticated (not authenticated error)', async () => {
      // First call: CLI available
      vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as ExecaReturnValue<string>)
      // Second call: projects list fails with auth error
      const authError = Object.assign(new Error('not authenticated'), {
        stderr: 'Error: not authenticated',
        exitCode: 1,
      }) as ExecaError
      vi.mocked(execa).mockRejectedValueOnce(authError)

      const result = await provider.isAuthenticated()

      expect(result).toBe(false)
    })

    it('should return false when not logged in', async () => {
      vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as ExecaReturnValue<string>)
      const authError = Object.assign(new Error('not logged in'), {
        stderr: 'Error: you need to be logged in to use this command',
        exitCode: 1,
      }) as ExecaError
      vi.mocked(execa).mockRejectedValueOnce(authError)

      const result = await provider.isAuthenticated()

      expect(result).toBe(false)
    })

    it('should return false when access token not provided', async () => {
      vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as ExecaReturnValue<string>)
      const authError = Object.assign(new Error('access token not provided'), {
        stderr: 'Error: access token not provided',
        exitCode: 1,
      }) as ExecaError
      vi.mocked(execa).mockRejectedValueOnce(authError)

      const result = await provider.isAuthenticated()

      expect(result).toBe(false)
    })

    it('should throw for unexpected non-auth errors', async () => {
      vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as ExecaReturnValue<string>)
      const unexpectedError = Object.assign(new Error('unexpected error'), {
        stderr: 'Error: something unexpected happened',
        exitCode: 2,
      }) as ExecaError
      vi.mocked(execa).mockRejectedValueOnce(unexpectedError)

      await expect(provider.isAuthenticated()).rejects.toThrow('unexpected error')
    })
  })

  describe('sanitizeBranchName', () => {
    it('should replace forward slashes with hyphens', () => {
      const result = provider.sanitizeBranchName('feat/issue-5__database')

      expect(result).toBe('feat-issue-5__database')
    })

    it('should handle multiple slashes', () => {
      const result = provider.sanitizeBranchName('feature/issue/25/test')

      expect(result).toBe('feature-issue-25-test')
    })

    it('should return unchanged string with no slashes', () => {
      const result = provider.sanitizeBranchName('issue-25')

      expect(result).toBe('issue-25')
    })

    it('should handle empty string', () => {
      const result = provider.sanitizeBranchName('')

      expect(result).toBe('')
    })
  })

  describe('listBranches', () => {
    it('should return array of branch names', async () => {
      const mockBranches = [
        { name: 'main', id: 'branch-main-123' },
        { name: 'development', id: 'branch-dev-456' },
        { name: 'feat-issue-5-database', id: 'branch-feat-789' },
      ]
      vi.mocked(execa).mockResolvedValue({
        stdout: JSON.stringify(mockBranches),
        stderr: '',
      } as ExecaReturnValue<string>)

      const result = await provider.listBranches()

      expect(result).toEqual(['main', 'development', 'feat-issue-5-database'])
      expect(execa).toHaveBeenCalledWith(
        'supabase',
        ['branches', 'list', '--project-ref', 'test-project-ref', '-o', 'json'],
        expect.any(Object)
      )
    })

    it('should handle empty branch list', async () => {
      vi.mocked(execa).mockResolvedValue({
        stdout: '[]',
        stderr: '',
      } as ExecaReturnValue<string>)

      const result = await provider.listBranches()

      expect(result).toEqual([])
    })

    it('should throw on CLI error', async () => {
      const cliError = Object.assign(new Error('command failed'), {
        stderr: 'Error: project not found',
        exitCode: 1,
      }) as ExecaError
      vi.mocked(execa).mockRejectedValue(cliError)

      await expect(provider.listBranches()).rejects.toThrow('command failed')
    })

    it('should throw when provider is not configured', async () => {
      const unconfiguredProvider = new SupabaseProvider({ projectRef: '', parentBranch: '' })

      await expect(unconfiguredProvider.listBranches()).rejects.toThrow(
        'SupabaseProvider is not configured'
      )
    })
  })

  describe('branchExists', () => {
    it('should return true when branch exists', async () => {
      vi.mocked(execa).mockResolvedValue({
        stdout: '{"name":"feat-issue-5-database","id":"branch-feat-789"}',
        stderr: '',
      } as ExecaReturnValue<string>)

      const result = await provider.branchExists('feat-issue-5-database')

      expect(result).toBe(true)
      expect(execa).toHaveBeenCalledWith(
        'supabase',
        ['branches', 'get', 'feat-issue-5-database', '--project-ref', 'test-project-ref'],
        expect.any(Object)
      )
    })

    it('should return false when branch does not exist (not found in error message)', async () => {
      const notFoundError = Object.assign(new Error('branch not found'), {
        stderr: 'Error: branch not found',
        exitCode: 1,
      })
      vi.mocked(execa).mockRejectedValue(notFoundError)

      const result = await provider.branchExists('nonexistent-branch')

      expect(result).toBe(false)
    })

    it('should return false when branch does not exist (exit code 1)', async () => {
      const notFoundError = Object.assign(new Error('command failed'), {
        stderr: '',
        exitCode: 1,
      })
      vi.mocked(execa).mockRejectedValue(notFoundError)

      const result = await provider.branchExists('nonexistent-branch')

      expect(result).toBe(false)
    })

    it('should rethrow auth errors instead of returning false', async () => {
      const authError = Object.assign(new Error('not authenticated'), {
        stderr: 'Error: not authenticated',
        exitCode: 2,
        code: 'ERR_NON_ZERO_EXIT',
      })
      vi.mocked(execa).mockRejectedValue(authError)

      await expect(provider.branchExists('some-branch')).rejects.toThrow('not authenticated')
    })
  })

  describe('getConnectionString', () => {
    it('should parse POSTGRES_URL_NON_POOLING from env output', async () => {
      const envOutput = [
        'DB_HOST=db.example.supabase.co',
        'DB_PORT=5432',
        'POSTGRES_URL_NON_POOLING=postgresql://postgres:password@db.example.supabase.co:5432/postgres',
        'DB_USER=postgres',
      ].join('\n')
      vi.mocked(execa).mockResolvedValue({
        stdout: envOutput,
        stderr: '',
      } as ExecaReturnValue<string>)

      const result = await provider.getConnectionString('feat-issue-5')

      expect(result).toBe(
        'postgresql://postgres:password@db.example.supabase.co:5432/postgres'
      )
      expect(execa).toHaveBeenCalledWith(
        'supabase',
        [
          'branches',
          'get',
          'feat-issue-5',
          '--project-ref',
          'test-project-ref',
          '-o',
          'env',
        ],
        expect.any(Object)
      )
    })

    it('should throw when branch not found', async () => {
      vi.mocked(execa).mockRejectedValue(new Error('branch not found'))

      await expect(provider.getConnectionString('nonexistent-branch')).rejects.toThrow(
        'branch not found'
      )
    })

    it('should throw when POSTGRES_URL_NON_POOLING not in output', async () => {
      vi.mocked(execa).mockResolvedValue({
        stdout: 'DB_HOST=db.example.supabase.co\nDB_PORT=5432',
        stderr: '',
      } as ExecaReturnValue<string>)

      await expect(provider.getConnectionString('feat-issue-5')).rejects.toThrow(
        'Could not find POSTGRES_URL_NON_POOLING'
      )
    })
  })

  describe('createBranch', () => {
    it('should create branch with --with-data when config.withData is true', async () => {
      const mockConnectionString =
        'postgresql://postgres:pass@db.example.supabase.co:5432/postgres'
      // First call: create branch
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'Branch created successfully',
        stderr: '',
      } as ExecaReturnValue<string>)
      // Second call: get connection string
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: `POSTGRES_URL_NON_POOLING=${mockConnectionString}`,
        stderr: '',
      } as ExecaReturnValue<string>)

      const result = await provider.createBranch('feat/issue-5')

      expect(result).toBe(mockConnectionString)
      // Supabase CLI uses positional name arg; no --branch-name flag exists
      expect(execa).toHaveBeenCalledWith(
        'supabase',
        [
          'branches',
          'create',
          'feat-issue-5',
          '--project-ref',
          'test-project-ref',
          '--with-data',
        ],
        expect.any(Object)
      )
    })

    it('should create branch without --with-data when config.withData is false', async () => {
      const providerNoData = new SupabaseProvider({
        projectRef: 'test-project-ref',
        parentBranch: 'main',
        withData: false,
      })
      const mockConnectionString = 'postgresql://postgres:pass@db.example.supabase.co:5432/postgres'
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'Branch created',
        stderr: '',
      } as ExecaReturnValue<string>)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: `POSTGRES_URL_NON_POOLING=${mockConnectionString}`,
        stderr: '',
      } as ExecaReturnValue<string>)

      const result = await providerNoData.createBranch('feat-issue-5')

      expect(result).toBe(mockConnectionString)
      // Should not include --with-data
      expect(execa).toHaveBeenCalledWith(
        'supabase',
        [
          'branches',
          'create',
          'feat-issue-5',
          '--project-ref',
          'test-project-ref',
        ],
        expect.any(Object)
      )
    })

    it('should ignore fromBranch parameter (Supabase always branches from production)', async () => {
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'Branch created',
        stderr: '',
      } as ExecaReturnValue<string>)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'POSTGRES_URL_NON_POOLING=postgresql://connection',
        stderr: '',
      } as ExecaReturnValue<string>)

      await provider.createBranch('my-feature', 'staging')

      // --branch-name or similar parent flag should NOT be in args
      expect(execa).toHaveBeenCalledWith(
        'supabase',
        expect.not.arrayContaining(['--branch-name', 'staging']),
        expect.any(Object)
      )
    })

    it('should sanitize branch name before creation', async () => {
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'Branch created',
        stderr: '',
      } as ExecaReturnValue<string>)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'POSTGRES_URL_NON_POOLING=postgresql://connection',
        stderr: '',
      } as ExecaReturnValue<string>)

      await provider.createBranch('feature/issue/25/test')

      expect(execa).toHaveBeenCalledWith(
        'supabase',
        expect.arrayContaining(['create', 'feature-issue-25-test']),
        expect.any(Object)
      )
    })

    it('should return connection string after creation', async () => {
      const mockConnectionString = 'postgresql://postgres:pass@db.example.supabase.co:5432/postgres'
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'Branch created',
        stderr: '',
      } as ExecaReturnValue<string>)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: `POSTGRES_URL_NON_POOLING=${mockConnectionString}`,
        stderr: '',
      } as ExecaReturnValue<string>)

      const result = await provider.createBranch('feat-issue-5')

      expect(result).toBe(mockConnectionString)
    })

    it('should throw on creation failure', async () => {
      vi.mocked(execa).mockRejectedValueOnce(new Error('Failed to create branch'))

      await expect(provider.createBranch('feat-issue-5')).rejects.toThrow(
        'Failed to create branch'
      )
    })

    it('should default withData to true when not specified in config', async () => {
      const providerDefaultData = new SupabaseProvider({
        projectRef: 'test-project-ref',
        parentBranch: 'main',
        // withData not specified - should default to true
      })
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'Branch created',
        stderr: '',
      } as ExecaReturnValue<string>)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'POSTGRES_URL_NON_POOLING=postgresql://connection',
        stderr: '',
      } as ExecaReturnValue<string>)

      await providerDefaultData.createBranch('feat-issue-5')

      expect(execa).toHaveBeenCalledWith(
        'supabase',
        expect.arrayContaining(['--with-data']),
        expect.any(Object)
      )
    })
  })

  describe('deleteBranch', () => {
    it('should return deleted=true when branch deleted successfully', async () => {
      // First call: branchExists check via 'branches get'
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '{"name":"feat-issue-5","id":"branch-123"}',
        stderr: '',
      } as ExecaReturnValue<string>)
      // Second call: delete branch
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'Branch deleted',
        stderr: '',
      } as ExecaReturnValue<string>)

      const result = await provider.deleteBranch('feat-issue-5', false)

      expect(execa).toHaveBeenCalledWith(
        'supabase',
        ['branches', 'delete', 'feat-issue-5', '--project-ref', 'test-project-ref'],
        expect.any(Object)
      )
      expect(result).toEqual({
        success: true,
        deleted: true,
        notFound: false,
        branchName: 'feat-issue-5',
      })
    })

    it('should return notFound=true when branch does not exist', async () => {
      // branchExists check via 'branches get' throws (branch not found)
      vi.mocked(execa).mockRejectedValueOnce(new Error('branch not found'))

      const result = await provider.deleteBranch('nonexistent-branch', false)

      expect(result).toEqual({
        success: true,
        deleted: false,
        notFound: true,
        branchName: 'nonexistent-branch',
      })
    })

    it('should return success=false on deletion error', async () => {
      // First call: branchExists check - branch exists
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '{"name":"feat-issue-5","id":"branch-123"}',
        stderr: '',
      } as ExecaReturnValue<string>)
      // Second call: delete branch fails
      vi.mocked(execa).mockRejectedValueOnce(new Error('Supabase CLI error: deletion failed'))

      const result = await provider.deleteBranch('feat-issue-5', false)

      expect(result).toEqual({
        success: false,
        deleted: false,
        notFound: false,
        error: 'Supabase CLI error: deletion failed',
        branchName: 'feat-issue-5',
      })
    })

    it('should accept and ignore isPreview parameter', async () => {
      // branchExists check - not found
      vi.mocked(execa).mockRejectedValueOnce(new Error('branch not found'))

      // Should not throw when isPreview=true; just proceeds normally
      const result = await provider.deleteBranch('feat-issue-5', true)

      expect(result.success).toBe(true)
      expect(result.notFound).toBe(true)
    })

    it('should sanitize branch name before deletion', async () => {
      // branchExists check via 'branches get' with sanitized name
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: '{"name":"feat-issue-5","id":"branch-123"}',
        stderr: '',
      } as ExecaReturnValue<string>)
      vi.mocked(execa).mockResolvedValueOnce({
        stdout: 'Branch deleted',
        stderr: '',
      } as ExecaReturnValue<string>)

      const result = await provider.deleteBranch('feat/issue-5')

      // Should use sanitized name (hyphens instead of slashes)
      expect(execa).toHaveBeenCalledWith(
        'supabase',
        ['branches', 'delete', 'feat-issue-5', '--project-ref', 'test-project-ref'],
        expect.any(Object)
      )
      expect(result.branchName).toBe('feat-issue-5')
    })
  })

  describe('findPreviewBranch', () => {
    it('should always return null (Neon-specific concept not applicable to Supabase)', async () => {
      const result = await provider.findPreviewBranch('feat-issue-5')

      expect(result).toBeNull()
      // Should not make any CLI calls
      expect(execa).not.toHaveBeenCalled()
    })
  })

  describe('getBranchNameFromEndpoint', () => {
    it('should always return null (Neon-specific concept not applicable to Supabase)', async () => {
      const result = await provider.getBranchNameFromEndpoint('ep-some-endpoint')

      expect(result).toBeNull()
      // Should not make any CLI calls
      expect(execa).not.toHaveBeenCalled()
    })
  })
})
