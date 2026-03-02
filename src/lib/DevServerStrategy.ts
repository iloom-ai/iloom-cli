/**
 * Options for running a dev server in foreground mode.
 */
export interface ForegroundOpts {
	/** If true, redirect stdout/stderr to stderr (useful for JSON output mode) */
	redirectToStderr?: boolean
	/** Called immediately after process/container starts with PID (if available) */
	onProcessStarted?: (pid?: number) => void
	/** Additional environment variables to pass to the server process/container */
	envOverrides?: Record<string, string>
}

/**
 * DevServerStrategy defines the common interface for running a dev server,
 * whether natively (as a host process) or inside a Docker container.
 *
 * All methods operate on a specific port and worktree path.
 * Identifier is optional and used by Docker strategies for container naming.
 */
export interface DevServerStrategy {
	/**
	 * Check whether the dev server is currently running.
	 *
	 * @param port - The port to check
	 * @param identifier - Optional identifier (issue number, branch) for container-based checks
	 */
	isRunning(port: number, identifier?: string | number): Promise<boolean>

	/**
	 * Start the dev server in background (non-blocking).
	 * Returns once the server is ready to accept connections.
	 *
	 * @param worktreePath - Absolute path to the worktree
	 * @param port - Port the server should listen on
	 * @param envOverrides - Additional environment variables
	 */
	startBackground(
		worktreePath: string,
		port: number,
		envOverrides?: Record<string, string>
	): Promise<void>

	/**
	 * Start the dev server in foreground (blocking).
	 * Returns once the server process/container exits.
	 *
	 * @param worktreePath - Absolute path to the worktree
	 * @param port - Port the server should listen on
	 * @param opts - Foreground options (stdio redirect, env overrides, process started callback)
	 */
	startForeground(
		worktreePath: string,
		port: number,
		opts: ForegroundOpts
	): Promise<{ pid?: number }>

	/**
	 * Stop the dev server.
	 *
	 * @param port - The port the server is listening on
	 * @param identifier - Optional identifier for container-based stops
	 * @returns true if a server was stopped, false if nothing was running
	 */
	stop(port: number, identifier?: string | number): Promise<boolean>
}
