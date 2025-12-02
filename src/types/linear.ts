/**
 * Linear API response types (from linearis CLI JSON output)
 */

/**
 * Linear issue response from linearis CLI
 */
export interface LinearIssue {
  /** Linear internal UUID */
  id: string
  /** Issue identifier in TEAM-NUMBER format (e.g., ENG-123) */
  identifier: string
  /** Issue title */
  title: string
  /** Issue description (markdown) */
  description: string | null
  /** Current workflow state */
  state: {
    id: string
    /** State name (e.g., "Todo", "In Progress", "Done") */
    name: string
    /** State type */
    type: 'started' | 'unstarted' | 'completed' | 'canceled'
  }
  /** Issue labels */
  labels: { name: string }[]
  /** Assigned user */
  assignee: { name: string; displayName?: string } | null
  /** Linear web URL (may not be returned by linearis CLI) */
  url?: string
  /** Creation timestamp */
  createdAt: string
  /** Last update timestamp */
  updatedAt: string
  /** Team information */
  team: {
    id: string
    /** Team key (e.g., "ENG", "PLAT") */
    key: string
    /** Team name */
    name: string
  }
}

/**
 * Linear comment response from linearis CLI
 */
export interface LinearComment {
  /** Comment UUID */
  id: string
  /** Comment body (markdown) */
  body: string
  /** Creation timestamp */
  createdAt: string
  /** Comment author */
  user: { name: string; displayName?: string }
}

/**
 * Linear error codes
 */
export type LinearErrorCode =
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'INVALID_STATE'
  | 'RATE_LIMITED'
  | 'CLI_NOT_FOUND'
  | 'CLI_ERROR'

/**
 * Linear error details
 */
export interface LinearError {
  code: LinearErrorCode
  message: string
  details?: unknown
}

/**
 * Custom error class for Linear operations
 */
export class LinearServiceError extends Error {
  constructor(
    public code: LinearErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'LinearServiceError'
    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LinearServiceError)
    }
  }
}
