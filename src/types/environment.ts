export interface EnvVariable {
  key: string
  value: string
}

export interface EnvFileOptions {
  path: string
  backup?: boolean
  encoding?: BufferEncoding
}

/**
 * @deprecated Use exception-based error handling instead
 */
export interface EnvOperationResult {
  success: boolean
  backupPath?: string
  error?: string
}

export interface PortAssignmentOptions {
  basePort?: number
  issueNumber?: string | number
  prNumber?: number
  branchName?: string // For deterministic branch-based port calculation
}
