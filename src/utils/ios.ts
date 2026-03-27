import os from 'node:os'
import path from 'node:path'

import { execa } from 'execa'
import fs from 'fs-extra'

// --- Types ---

export interface SimulatorInfo {
	udid: string
	name: string
	state: string // 'Booted' | 'Shutdown' | etc.
	runtime: string // e.g. 'iOS 18.0'
}

export interface ConnectedDevice {
	udid: string
	name: string
}

export interface XcodeBuildOptions {
	workspacePath?: string // path to .xcworkspace
	projectPath?: string // path to .xcodeproj (used if no workspace)
	scheme: string
	configuration?: string // default 'Debug'
	derivedDataPath?: string
}

export interface SimulatorBuildOptions extends XcodeBuildOptions {
	simulatorName?: string // e.g. 'iPhone 16' — used in destination filter
}

export interface DeviceBuildOptions extends XcodeBuildOptions {
	deviceUDID?: string
	developmentTeam: string
}

// --- Constants ---

const TRACKING_DIR = path.join(os.homedir(), '.config', 'iloom-ai')
const TRACKING_FILE = path.join(TRACKING_DIR, 'ios-simulators.json')

// --- Platform Guard ---

/**
 * Assert that iOS development tools are available.
 * Checks that we're on macOS and that Xcode command line tools are installed.
 * Throws a clear, actionable error if either check fails.
 */
export async function assertIOSAvailable(): Promise<void> {
	if (process.platform !== 'darwin') {
		throw new Error(
			'iOS development tools are only available on macOS. ' +
				`Current platform: ${process.platform}`
		)
	}

	try {
		await execa('xcode-select', ['-p'])
	} catch {
		throw new Error(
			'Xcode Command Line Tools are not installed. ' +
				'Please install them by running: xcode-select --install'
		)
	}
}

// --- Simulator Management ---

/**
 * List available iOS simulators.
 * Calls `xcrun simctl list devices available -j` and parses the JSON output.
 * @returns Array of available simulators with UDID, name, state, and runtime
 */
export async function listSimulators(): Promise<SimulatorInfo[]> {
	await assertIOSAvailable()

	const result = await execa('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])
	const parsed: unknown = JSON.parse(result.stdout)

	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('devices' in parsed) ||
		typeof (parsed as Record<string, unknown>).devices !== 'object'
	) {
		return []
	}

	const devices = (parsed as { devices: Record<string, unknown[]> }).devices
	const simulators: SimulatorInfo[] = []

	for (const [runtimeIdentifier, deviceList] of Object.entries(devices)) {
		if (!Array.isArray(deviceList)) continue

		// Extract human-readable runtime from identifier
		// e.g. "com.apple.CoreSimulator.SimRuntime.iOS-18-0" -> "iOS 18.0"
		const runtimeMatch = /SimRuntime\.(.+)$/.exec(runtimeIdentifier)
		const runtime = runtimeMatch?.[1]
			? runtimeMatch[1].replace(/-/g, '.').replace(/\.(\d)/, ' $1')
			: runtimeIdentifier

		for (const device of deviceList) {
			const d = device as Record<string, unknown>
			if (typeof d.udid === 'string' && typeof d.name === 'string') {
				simulators.push({
					udid: d.udid,
					name: d.name,
					state: typeof d.state === 'string' ? d.state : 'Unknown',
					runtime,
				})
			}
		}
	}

	return simulators
}

/**
 * Boot an iOS simulator by UDID.
 * Handles the case where the simulator is already booted gracefully.
 * @param udid - The UDID of the simulator to boot
 */
export async function bootSimulator(udid: string): Promise<void> {
	await assertIOSAvailable()

	try {
		await execa('xcrun', ['simctl', 'boot', udid])
	} catch (error: unknown) {
		// simctl returns exit code 149 when the simulator is already booted
		if (
			error instanceof Error &&
			'exitCode' in error &&
			(error as { exitCode: number }).exitCode === 149
		) {
			return // Already booted — not an error
		}
		throw error
	}
}

/**
 * Shutdown an iOS simulator by UDID.
 * Handles the case where the simulator is already shut down gracefully.
 * @param udid - The UDID of the simulator to shut down
 */
export async function shutdownSimulator(udid: string): Promise<void> {
	await assertIOSAvailable()

	try {
		await execa('xcrun', ['simctl', 'shutdown', udid])
	} catch (error: unknown) {
		// Gracefully handle when the simulator is already shut down.
		// Match on the stable substring rather than the full localized message.
		if (
			error instanceof Error &&
			'stderr' in error &&
			typeof (error as { stderr: unknown }).stderr === 'string' &&
			(error as { stderr: string }).stderr.includes('current state: Shutdown')
		) {
			return
		}
		throw error
	}
}

/**
 * Install an .app bundle on a simulator.
 * @param udid - The UDID of the target simulator
 * @param appPath - Path to the .app bundle to install
 */
export async function installApp(udid: string, appPath: string): Promise<void> {
	await assertIOSAvailable()
	await execa('xcrun', ['simctl', 'install', udid, appPath])
}

/**
 * Launch an app by bundle identifier on a simulator.
 * @param udid - The UDID of the target simulator
 * @param bundleId - The bundle identifier of the app to launch
 */
export async function launchApp(udid: string, bundleId: string): Promise<void> {
	await assertIOSAvailable()
	await execa('xcrun', ['simctl', 'launch', udid, bundleId])
}

// --- xcodebuild Wrapper ---

/**
 * Build common xcodebuild arguments from options.
 */
function buildBaseArgs(options: XcodeBuildOptions): string[] {
	const args: string[] = []

	if (options.workspacePath) {
		args.push('-workspace', options.workspacePath)
	} else if (options.projectPath) {
		args.push('-project', options.projectPath)
	}

	args.push('-scheme', options.scheme)
	args.push('-configuration', options.configuration ?? 'Debug')

	if (options.derivedDataPath) {
		args.push('-derivedDataPath', options.derivedDataPath)
	}

	return args
}

/**
 * Build an iOS app for the simulator.
 * @param options - Build options including scheme, configuration, and simulator name
 * @returns Path to the built .app bundle in DerivedData
 */
export async function buildForSimulator(options: SimulatorBuildOptions): Promise<string> {
	await assertIOSAvailable()

	const args = buildBaseArgs(options)
	const simulatorName = options.simulatorName ?? 'iPhone 16'
	args.push('-destination', `platform=iOS Simulator,name=${simulatorName}`)
	args.push('-sdk', 'iphonesimulator')
	args.push('build')

	try {
		await execa('xcodebuild', args)
	} catch (error: unknown) {
		const e = error as { stderr?: string; stdout?: string }
		const output = e.stderr !== '' && e.stderr != null ? e.stderr : (e.stdout ?? '')
		throw new Error(`xcodebuild failed for simulator build:\n${output}`)
	}

	if (!options.derivedDataPath) {
		throw new Error(
			'derivedDataPath is required to locate the built .app bundle. ' +
				'Xcode places builds in a hashed subdirectory that cannot be predicted without it.'
		)
	}

	return path.join(
		options.derivedDataPath,
		'Build',
		'Products',
		`${options.configuration ?? 'Debug'}-iphonesimulator`
	)
}

/**
 * Build an iOS app for a physical device.
 * @param options - Build options including scheme, configuration, development team, and optional device UDID
 */
export async function buildForDevice(options: DeviceBuildOptions): Promise<void> {
	await assertIOSAvailable()

	const args = buildBaseArgs(options)

	if (options.deviceUDID) {
		args.push('-destination', `platform=iOS,id=${options.deviceUDID}`)
	} else {
		args.push('-destination', 'generic/platform=iOS')
	}

	args.push(`DEVELOPMENT_TEAM=${options.developmentTeam}`)
	args.push('build')

	try {
		await execa('xcodebuild', args)
	} catch (error: unknown) {
		const e = error as { stderr?: string; stdout?: string }
		const output = e.stderr !== '' && e.stderr != null ? e.stderr : (e.stdout ?? '')
		throw new Error(`xcodebuild failed for device build:\n${output}`)
	}
}

// --- Device Management ---

/**
 * List connected physical iOS devices.
 * Calls `xcrun xctrace list devices` and parses the output for physical devices.
 * @returns Array of connected devices with UDID and name
 */
export async function listConnectedDevices(): Promise<ConnectedDevice[]> {
	await assertIOSAvailable()

	const result = await execa('xcrun', ['xctrace', 'list', 'devices'])
	const lines = result.stdout.split('\n')
	const devices: ConnectedDevice[] = []

	// xctrace output has a "== Devices ==" section followed by "== Simulators ==" section
	let inDevicesSection = false

	for (const line of lines) {
		const trimmed = line.trim()

		if (trimmed === '== Devices ==') {
			inDevicesSection = true
			continue
		}

		if (trimmed.startsWith('== ') && trimmed !== '== Devices ==') {
			inDevicesSection = false
			continue
		}

		if (!inDevicesSection || !trimmed) continue

		// Format: "Device Name (OS Version) (UDID)" or "Device Name (OS Version (Build)) (UDID)"
		// Match greedily to handle nested parentheses in OS version; extract only the final (UDID) group.
		const match = /^(.*)\s+\(.*?\)\s+\(([0-9A-Za-z-]+)\)$/.exec(trimmed)
		if (match?.[1] && match[2]) {
			devices.push({
				name: match[1].trim(),
				udid: match[2],
			})
		}
	}

	return devices
}

// --- Simulator UDID Tracking ---

/**
 * Read the simulator tracking file.
 * @returns The parsed tracking data, or an empty object if the file doesn't exist
 */
async function readTrackingFile(): Promise<Record<string, string>> {
	try {
		const data = await fs.readJson(TRACKING_FILE)
		if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
			return data as Record<string, string>
		}
		return {}
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			'code' in error &&
			(error as NodeJS.ErrnoException).code === 'ENOENT'
		) {
			return {}
		}
		throw error
	}
}

/**
 * Track a simulator UDID for a worktree identifier.
 * Stores the mapping in ~/.config/iloom-ai/ios-simulators.json.
 * @param worktreeIdentifier - The worktree identifier (e.g., issue number, branch name)
 * @param udid - The simulator UDID to track
 */
export async function trackSimulator(
	worktreeIdentifier: string,
	udid: string
): Promise<void> {
	const tracking = await readTrackingFile()
	tracking[worktreeIdentifier] = udid
	await fs.ensureDir(TRACKING_DIR)
	await fs.writeJson(TRACKING_FILE, tracking, { spaces: 2 })
}

/**
 * Get the tracked simulator UDID for a worktree identifier.
 * @param worktreeIdentifier - The worktree identifier to look up
 * @returns The tracked simulator UDID, or null if none tracked
 */
export async function getTrackedSimulator(
	worktreeIdentifier: string
): Promise<string | null> {
	const tracking = await readTrackingFile()
	return tracking[worktreeIdentifier] ?? null
}

/**
 * Clear the tracked simulator for a worktree identifier.
 * @param worktreeIdentifier - The worktree identifier to remove
 */
export async function clearTrackedSimulator(
	worktreeIdentifier: string
): Promise<void> {
	const tracking = await readTrackingFile()
	delete tracking[worktreeIdentifier]
	await fs.ensureDir(TRACKING_DIR)
	await fs.writeJson(TRACKING_FILE, tracking, { spaces: 2 })
}
