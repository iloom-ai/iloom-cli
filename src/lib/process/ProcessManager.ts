import { execa } from 'execa'
import { setTimeout } from 'timers/promises'
import type { ProcessInfo, Platform } from '../../types/process.js'
import { calculatePortForBranch } from '../../utils/port.js'

/**
 * Manages process detection and termination across platforms
 * Ports dev server termination logic from bash/merge-and-clean.sh lines 1092-1148
 */
export class ProcessManager {
	private readonly platform: Platform

	constructor() {
		this.platform = this.detectPlatform()
	}

	/**
	 * Detect current platform
	 */
	private detectPlatform(): Platform {
		switch (process.platform) {
			case 'darwin':
				return 'darwin'
			case 'linux':
				return 'linux'
			case 'win32':
				return 'win32'
			default:
				return 'unsupported'
		}
	}

	/**
	 * Detect if a dev server is running on the specified port
	 * Ports logic from merge-and-clean.sh lines 1107-1123
	 */
	async detectDevServer(port: number): Promise<ProcessInfo | null> {
		if (this.platform === 'unsupported') {
			throw new Error('Process detection not supported on this platform')
		}

		// Use platform-specific detection
		if (this.platform === 'win32') {
			return await this.detectOnPortWindows(port)
		} else {
			return await this.detectOnPortUnix(port)
		}
	}

	/**
	 * Unix/macOS implementation using lsof
	 * Ports bash lines 1107-1123
	 */
	private async detectOnPortUnix(port: number): Promise<ProcessInfo | null> {
		try {
			// Run lsof to find process listening on port (LISTEN only)
			const result = await execa('lsof', ['-i', `:${port}`, '-P'], {
				reject: false,
			})

			// Filter for LISTEN state only
			const lines = result.stdout.split('\n').filter(line => line.includes('LISTEN'))

			if (lines.length === 0) {
				return null
			}

			// Parse first LISTEN line
			const firstLine = lines[0]
			if (!firstLine) return null

			const parts = firstLine.split(/\s+/)
			if (parts.length < 2) return null

			const processName = parts[0] ?? ''
			const pid = parseInt(parts[1] ?? '', 10)

			if (isNaN(pid)) {
				return null
			}

			// Get full command line using ps
			const psResult = await execa('ps', ['-p', pid.toString(), '-o', 'command='], {
				reject: false,
			})
			const fullCommand = psResult.stdout.trim()

			// Validate if this is a dev server
			const isDevServer = this.isDevServerProcess(processName, fullCommand)

			return {
				pid,
				name: processName,
				command: fullCommand,
				port,
				isDevServer,
			}
		} catch {
			// If lsof fails, assume no process on port
			return null
		}
	}

	/**
	 * Windows implementation using netstat and tasklist
	 */
	private async detectOnPortWindows(port: number): Promise<ProcessInfo | null> {
		try {
			// Use netstat to find PID listening on port
			const result = await execa('netstat', ['-ano'], { reject: false })
			const lines = result.stdout.split('\n')

			// Find line with our port and LISTENING state
			const portLine = lines.find(
				line => line.includes(`:${port}`) && line.includes('LISTENING')
			)

			if (!portLine) {
				return null
			}

			// Extract PID (last column)
			const parts = portLine.trim().split(/\s+/)
			const lastPart = parts[parts.length - 1]
			if (!lastPart) return null

			const pid = parseInt(lastPart, 10)

			if (isNaN(pid)) {
				return null
			}

			// Get process info using tasklist
			const taskResult = await execa(
				'tasklist',
				['/FI', `PID eq ${pid}`, '/FO', 'CSV'],
				{
					reject: false,
				}
			)

			// Parse CSV output
			const lines2 = taskResult.stdout.split('\n')
			if (lines2.length < 2) {
				return null
			}

			const secondLine = lines2[1]
			if (!secondLine) return null

			const parts2 = secondLine.split(',')
			const processName = (parts2[0] ?? '').replace(/"/g, '')

			// TODO: Get full command line on Windows (more complex)
			const fullCommand = processName

			const isDevServer = this.isDevServerProcess(processName, fullCommand)

			return {
				pid,
				name: processName,
				command: fullCommand,
				port,
				isDevServer,
			}
		} catch {
			return null
		}
	}

	/**
	 * Validate if process is a dev server
	 * Ports logic from merge-and-clean.sh lines 1121-1123
	 */
	private isDevServerProcess(processName: string, command: string): boolean {
		// Check process name patterns
		const devServerNames = /^(node|npm|pnpm|yarn|next|next-server|vite|webpack|dev-server)$/i
		if (devServerNames.test(processName)) {
			// Additional validation via command line
			const devServerCommands =
				/(next dev|next-server|npm.*dev|pnpm.*dev|yarn.*dev|vite|webpack.*serve|turbo.*dev|dev.*server)/i
			return devServerCommands.test(command)
		}

		// Check command line alone
		const devServerCommands =
			/(next dev|next-server|npm.*dev|pnpm.*dev|yarn.*dev|vite|webpack.*serve|turbo.*dev|dev.*server)/i
		return devServerCommands.test(command)
	}

	/**
	 * Terminate a process by PID
	 * Ports logic from merge-and-clean.sh lines 1126-1139
	 */
	async terminateProcess(pid: number): Promise<boolean> {
		try {
			if (this.platform === 'win32') {
				// Windows: use taskkill
				await execa('taskkill', ['/PID', pid.toString(), '/F'], { reject: true })
			} else {
				// Unix/macOS: use kill -9
				process.kill(pid, 'SIGKILL')
			}

			// Wait briefly for process to die
			await setTimeout(1000)

			return true
		} catch (error) {
			throw new Error(
				`Failed to terminate process ${pid}: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
		}
	}

	/**
	 * Verify that a port is free
	 * Ports verification logic from merge-and-clean.sh lines 1135-1139
	 */
	async verifyPortFree(port: number): Promise<boolean> {
		const processInfo = await this.detectDevServer(port)
		return processInfo === null
	}

	/**
	 * Calculate dev server port from issue/PR number
	 * Ports logic from merge-and-clean.sh lines 1093-1098
	 * For alphanumeric identifiers, uses hash-based port calculation
	 */
	calculatePort(number: string | number): number {
		// For numeric identifiers, use simple arithmetic (original behavior)
		if (typeof number === 'number') {
			return 3000 + number
		}

		// For string identifiers, try numeric conversion first
		const numericValue = Number(number)
		if (!isNaN(numericValue) && isFinite(numericValue)) {
			return 3000 + numericValue
		}

		// For non-numeric strings (alphanumeric identifiers), use hash-based calculation
		return calculatePortForBranch(`issue-${number}`, 3000)
	}
}
