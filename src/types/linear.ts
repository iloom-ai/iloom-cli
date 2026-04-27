/**
 * Linear API response types (from @linear/sdk)
 */

/**
 * Linear issue attachment (paperclip-uploaded files separate from description body)
 */
export interface LinearIssueAttachment {
  /** Attachment UUID */
  id: string
  /** Attachment URL (may be on uploads.linear.app or external) */
  url: string
  /** Title shown in Linear's attachment widget */
  title: string
  /** Optional subtitle */
  subtitle?: string
}

/**
 * Linear issue response from SDK
 */
export interface LinearIssue {
  /** Linear internal UUID */
  id: string
  /** Issue identifier in TEAM-NUMBER format (e.g., ENG-123) */
  identifier: string
  /** Issue title */
  title: string
  /** Issue description (markdown) */
  description?: string
  /** Current workflow state name */
  state?: string
  /** Linear web URL */
  url: string
  /** Creation timestamp (ISO string) */
  createdAt: string
  /** Last update timestamp (ISO string) */
  updatedAt: string
  /** Issue attachments (paperclip-uploaded files) */
  attachments?: LinearIssueAttachment[]
}

/**
 * Linear comment response from SDK
 */
export interface LinearComment {
  /** Comment UUID */
  id: string
  /** Comment body (markdown) */
  body: string
  /** Creation timestamp (ISO string) */
  createdAt: string
  /** Last update timestamp (ISO string) */
  updatedAt: string
  /** Comment URL */
  url: string
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
