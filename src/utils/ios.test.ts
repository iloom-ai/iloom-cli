import path from 'node:path'

import { describe, it, expect, vi } from 'vitest'
import { execa } from 'execa'
import fs from 'fs-extra'

import {
	assertIOSAvailable,
	assertMacOS,
	MacOSRequiredError,
	isReactNativeProject,
	listSimulators,
	bootSimulator,
	shutdownSimulator,
	installApp,
	launchApp,
	buildForSimulator,
	buildForDevice,
	listConnectedDevices,
	trackSimulator,
	getTrackedSimulator,
	clearTrackedSimulator,
} from './ios.js'

vi.mock('execa')
vi.mock('fs-extra')
vi.mock('./logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

// --- Platform Guard: assertMacOS ---

describe('assertMacOS', () => {
	it('should not throw on darwin platform', () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			expect(() => assertMacOS()).not.toThrow()
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('should throw MacOSRequiredError on linux platform', () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
		try {
			expect(() => assertMacOS()).toThrow(MacOSRequiredError)
			expect(() => assertMacOS()).toThrow('iOS development requires macOS')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('should throw MacOSRequiredError on win32 platform', () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
		try {
			expect(() => assertMacOS()).toThrow(MacOSRequiredError)
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

// --- MacOSRequiredError ---

describe('MacOSRequiredError', () => {
	it('should have correct name and message', () => {
		const error = new MacOSRequiredError()
		expect(error.name).toBe('MacOSRequiredError')
		expect(error.message).toContain('iOS development requires macOS')
		expect(error.message).toContain('Xcode')
		expect(error).toBeInstanceOf(Error)
	})
})

// --- Capability Helpers ---

describe('isReactNativeProject', () => {
	it('should return true when project has both web and ios capabilities', () => {
		expect(isReactNativeProject(['web', 'ios'])).toBe(true)
	})

	it('should return false when project has only ios capability', () => {
		expect(isReactNativeProject(['ios'])).toBe(false)
	})

	it('should return false when project has only web capability', () => {
		expect(isReactNativeProject(['web'])).toBe(false)
	})

	it('should return false when project has no capabilities', () => {
		expect(isReactNativeProject([])).toBe(false)
	})

	it('should return true when project has web, ios, and cli capabilities', () => {
		expect(isReactNativeProject(['web', 'ios', 'cli'])).toBe(true)
	})
})

// --- Platform Guard: assertIOSAvailable ---

describe('assertIOSAvailable', () => {
	it('succeeds on macOS with xcode-select present', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: '/Applications/Xcode.app/Contents/Developer',
				stderr: '',
			} as never)

			await expect(assertIOSAvailable()).resolves.toBeUndefined()
			expect(execa).toHaveBeenCalledWith('xcode-select', ['-p'])
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('throws on non-macOS platforms with clear message', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
		try {
			await expect(assertIOSAvailable()).rejects.toThrow(
				'iOS development tools are only available on macOS'
			)
			await expect(assertIOSAvailable()).rejects.toThrow('linux')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('throws on macOS without Xcode CLI tools', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa).mockRejectedValue(
				new Error('xcode-select: error: command line tools are not installed')
			)

			await expect(assertIOSAvailable()).rejects.toThrow(
				'Xcode Command Line Tools are not installed'
			)
			await expect(assertIOSAvailable()).rejects.toThrow('xcode-select --install')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

// --- Simulator Management ---

describe('listSimulators', () => {
	const setDarwin = () => {
		const orig = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		return orig
	}

	it('parses xcrun simctl list output and returns simulator array', async () => {
		const originalPlatform = setDarwin()
		try {
			const simctlOutput = {
				devices: {
					'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
						{ udid: 'AAA-BBB', name: 'iPhone 16', state: 'Shutdown', isAvailable: true },
						{ udid: 'CCC-DDD', name: 'iPad Pro', state: 'Booted', isAvailable: true },
					],
					'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
						{ udid: 'EEE-FFF', name: 'iPhone 15', state: 'Shutdown', isAvailable: true },
					],
				},
			}

			vi.mocked(execa)
				// assertIOSAvailable call
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				// simctl list call
				.mockResolvedValueOnce({
					exitCode: 0,
					stdout: JSON.stringify(simctlOutput),
					stderr: '',
				} as never)

			const simulators = await listSimulators()

			expect(simulators).toHaveLength(3)
			expect(simulators[0]).toEqual({
				udid: 'AAA-BBB',
				name: 'iPhone 16',
				state: 'Shutdown',
				runtime: 'iOS 18.0',
			})
			expect(simulators[1]).toEqual({
				udid: 'CCC-DDD',
				name: 'iPad Pro',
				state: 'Booted',
				runtime: 'iOS 18.0',
			})
			expect(simulators[2]).toEqual({
				udid: 'EEE-FFF',
				name: 'iPhone 15',
				state: 'Shutdown',
				runtime: 'iOS 17.5',
			})

			expect(execa).toHaveBeenCalledWith('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('throws when xcrun fails', async () => {
		const originalPlatform = setDarwin()
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockRejectedValueOnce(new Error('xcrun failed'))

			await expect(listSimulators()).rejects.toThrow('xcrun failed')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

describe('bootSimulator', () => {
	it('boots simulator by UDID', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

			await expect(bootSimulator('AAA-BBB')).resolves.toBeUndefined()
			expect(execa).toHaveBeenCalledWith('xcrun', ['simctl', 'boot', 'AAA-BBB'])
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('succeeds silently when simulator already booted (exit code 149)', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			const alreadyBootedError = Object.assign(
				new Error('Unable to boot device in current state: Booted'),
				{ exitCode: 149 }
			)

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockRejectedValueOnce(alreadyBootedError)

			await expect(bootSimulator('AAA-BBB')).resolves.toBeUndefined()
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('throws on other xcrun errors', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			const otherError = Object.assign(
				new Error('Invalid device UDID'),
				{ exitCode: 1 }
			)

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockRejectedValueOnce(otherError)

			await expect(bootSimulator('INVALID')).rejects.toThrow('Invalid device UDID')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

describe('shutdownSimulator', () => {
	it('shuts down simulator by UDID', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

			await expect(shutdownSimulator('AAA-BBB')).resolves.toBeUndefined()
			expect(execa).toHaveBeenCalledWith('xcrun', ['simctl', 'shutdown', 'AAA-BBB'])
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('succeeds when simulator is already shut down', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			const alreadyShutdownError = Object.assign(
				new Error('Unable to shutdown device'),
				{ stderr: 'Unable to shutdown device in current state: Shutdown', exitCode: 1 }
			)

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockRejectedValueOnce(alreadyShutdownError)

			await expect(shutdownSimulator('AAA-BBB')).resolves.toBeUndefined()
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

describe('installApp', () => {
	it('installs .app bundle on simulator by UDID', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

			await expect(installApp('AAA-BBB', '/path/to/MyApp.app')).resolves.toBeUndefined()
			expect(execa).toHaveBeenCalledWith('xcrun', ['simctl', 'install', 'AAA-BBB', '/path/to/MyApp.app'])
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('throws when install fails', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockRejectedValueOnce(new Error('Unable to install app'))

			await expect(installApp('AAA-BBB', '/bad/path.app')).rejects.toThrow('Unable to install app')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

describe('launchApp', () => {
	it('launches app by bundleId on simulator', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

			await expect(launchApp('AAA-BBB', 'com.example.MyApp')).resolves.toBeUndefined()
			expect(execa).toHaveBeenCalledWith('xcrun', ['simctl', 'launch', 'AAA-BBB', 'com.example.MyApp'])
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('throws when launch fails', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockRejectedValueOnce(new Error('App not found'))

			await expect(launchApp('AAA-BBB', 'com.bad.app')).rejects.toThrow('App not found')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

// --- xcodebuild Wrapper ---

describe('buildForSimulator', () => {
	it('calls xcodebuild with correct simulator destination args', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

			await buildForSimulator({
				workspacePath: '/path/to/MyApp.xcworkspace',
				scheme: 'MyApp',
				simulatorName: 'iPhone 16',
				derivedDataPath: '/tmp/DerivedData',
			})

			expect(execa).toHaveBeenCalledWith('xcodebuild', [
				'-workspace', '/path/to/MyApp.xcworkspace',
				'-scheme', 'MyApp',
				'-configuration', 'Debug',
				'-derivedDataPath', '/tmp/DerivedData',
				'-destination', 'platform=iOS Simulator,name=iPhone 16',
				'-sdk', 'iphonesimulator',
				'build',
			])
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('includes scheme, configuration, and derivedDataPath in args', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

			await buildForSimulator({
				projectPath: '/path/to/MyApp.xcodeproj',
				scheme: 'MyApp',
				configuration: 'Release',
				derivedDataPath: '/tmp/DerivedData',
			})

			expect(execa).toHaveBeenCalledWith('xcodebuild', [
				'-project', '/path/to/MyApp.xcodeproj',
				'-scheme', 'MyApp',
				'-configuration', 'Release',
				'-derivedDataPath', '/tmp/DerivedData',
				'-destination', 'platform=iOS Simulator,name=iPhone 16',
				'-sdk', 'iphonesimulator',
				'build',
			])
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('surfaces xcodebuild stderr on failure', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			const buildError = Object.assign(
				new Error('xcodebuild failed'),
				{ stderr: 'error: Scheme "BadScheme" is not found in the project', exitCode: 65 }
			)

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockRejectedValueOnce(buildError)

			await expect(
				buildForSimulator({ scheme: 'BadScheme', derivedDataPath: '/tmp/DerivedData' })
			).rejects.toThrow('Scheme "BadScheme" is not found')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('surfaces xcodebuild stdout on failure when stderr is empty', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			const buildError = Object.assign(
				new Error('xcodebuild failed'),
				{ stderr: '', stdout: 'BUILD FAILED\nerror: Missing target "MyApp"', exitCode: 65 }
			)

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockRejectedValueOnce(buildError)

			await expect(
				buildForSimulator({ scheme: 'MyApp', derivedDataPath: '/tmp/DerivedData' })
			).rejects.toThrow('Missing target "MyApp"')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('throws when derivedDataPath is not provided', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

			await expect(
				buildForSimulator({ scheme: 'MyApp' })
			).rejects.toThrow('derivedDataPath is required')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('returns the derived data products path', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

			const result = await buildForSimulator({
				scheme: 'MyApp',
				derivedDataPath: '/custom/DerivedData',
			})

			expect(result).toBe(
				path.join('/custom/DerivedData', 'Build', 'Products', 'Debug-iphonesimulator')
			)
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

describe('buildForDevice', () => {
	it('calls xcodebuild with device destination and developmentTeam', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

			await buildForDevice({
				workspacePath: '/path/to/MyApp.xcworkspace',
				scheme: 'MyApp',
				developmentTeam: 'ABC123DEF',
				deviceUDID: '00008101-001A2B3C4D5E6F7G',
			})

			expect(execa).toHaveBeenCalledWith('xcodebuild', [
				'-workspace', '/path/to/MyApp.xcworkspace',
				'-scheme', 'MyApp',
				'-configuration', 'Debug',
				'-destination', 'platform=iOS,id=00008101-001A2B3C4D5E6F7G',
				'DEVELOPMENT_TEAM=ABC123DEF',
				'build',
			], undefined)
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('uses generic platform destination when no deviceUDID specified', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

			await buildForDevice({
				scheme: 'MyApp',
				developmentTeam: 'ABC123DEF',
			})

			expect(execa).toHaveBeenCalledWith('xcodebuild', expect.arrayContaining([
				'-destination', 'generic/platform=iOS',
			]), undefined)
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('throws with xcodebuild stderr on signing failure', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			const signingError = Object.assign(
				new Error('xcodebuild failed'),
				{
					stderr: 'error: No signing certificate "iOS Development" found',
					exitCode: 65,
				}
			)

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockRejectedValueOnce(signingError)

			await expect(
				buildForDevice({ scheme: 'MyApp', developmentTeam: 'BAD_TEAM' })
			).rejects.toThrow('No signing certificate')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('surfaces xcodebuild stdout on failure when stderr is empty', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			const buildError = Object.assign(
				new Error('xcodebuild failed'),
				{ stderr: '', stdout: 'error: No profile matching team ID', exitCode: 65 }
			)

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockRejectedValueOnce(buildError)

			await expect(
				buildForDevice({ scheme: 'MyApp', developmentTeam: 'BAD_TEAM' })
			).rejects.toThrow('No profile matching team ID')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

// --- Device Management ---

describe('listConnectedDevices', () => {
	it('parses xcrun xctrace list devices output', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			const xctraceOutput = [
				'== Devices ==',
				"Adam's iPhone (17.5) (00008101-001A2B3C4D5E6F7G)",
				'iPad Pro (18.0) (00008103-AAAA-BBBB-CCCC)',
				'',
				'== Simulators ==',
				'iPhone 16 Simulator (18.0) (AAA-BBB-CCC)',
			].join('\n')

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: xctraceOutput, stderr: '' } as never)

			const devices = await listConnectedDevices()

			expect(devices).toHaveLength(2)
			expect(devices[0]).toEqual({
				name: "Adam's iPhone",
				udid: '00008101-001A2B3C4D5E6F7G',
			})
			expect(devices[1]).toEqual({
				name: 'iPad Pro',
				udid: '00008103-AAAA-BBBB-CCCC',
			})
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('returns empty array when no devices connected', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			const xctraceOutput = [
				'== Devices ==',
				'',
				'== Simulators ==',
				'iPhone 16 Simulator (18.0) (AAA-BBB-CCC)',
			].join('\n')

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0, stdout: '/path', stderr: '' } as never)
				.mockResolvedValueOnce({ exitCode: 0, stdout: xctraceOutput, stderr: '' } as never)

			const devices = await listConnectedDevices()

			expect(devices).toHaveLength(0)
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

// --- Simulator UDID Tracking ---

describe('trackSimulator / getTrackedSimulator / clearTrackedSimulator', () => {
	it('stores and retrieves simulator UDID by worktree identifier', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			let stored: Record<string, string> = {}

			vi.mocked(fs.readJson).mockImplementation(async () => stored)
			vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
			vi.mocked(fs.writeJson).mockImplementation(async (_path: string, data: unknown) => {
				stored = data as Record<string, string>
			})

			await trackSimulator('issue-123', 'AAA-BBB-CCC')

			expect(stored['issue-123']).toBe('AAA-BBB-CCC')
			expect(fs.writeJson).toHaveBeenCalledWith(
				expect.stringContaining('ios-simulators.json'),
				expect.objectContaining({ 'issue-123': 'AAA-BBB-CCC' }),
				{ spaces: 2 }
			)

			const result = await getTrackedSimulator('issue-123')
			expect(result).toBe('AAA-BBB-CCC')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('returns null when no simulator tracked', async () => {
		vi.mocked(fs.readJson).mockResolvedValue({})

		const result = await getTrackedSimulator('nonexistent')

		expect(result).toBeNull()
	})

	it('returns null when tracking file does not exist', async () => {
		vi.mocked(fs.readJson).mockRejectedValue(
			Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
		)

		const result = await getTrackedSimulator('issue-123')

		expect(result).toBeNull()
	})

	it('rethrows non-ENOENT errors from tracking file', async () => {
		vi.mocked(fs.readJson).mockRejectedValue(
			Object.assign(new Error('Permission denied'), { code: 'EACCES' })
		)

		await expect(getTrackedSimulator('issue-123')).rejects.toThrow('Permission denied')
	})

	it('overwrites existing tracking entry', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			let stored: Record<string, string> = { 'issue-123': 'OLD-UDID' }

			vi.mocked(fs.readJson).mockImplementation(async () => stored)
			vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
			vi.mocked(fs.writeJson).mockImplementation(async (_path: string, data: unknown) => {
				stored = data as Record<string, string>
			})

			await trackSimulator('issue-123', 'NEW-UDID')

			expect(stored['issue-123']).toBe('NEW-UDID')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})

	it('clears a tracked simulator entry', async () => {
		const originalPlatform = process.platform
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
		try {
			let stored: Record<string, string> = { 'issue-123': 'AAA-BBB', 'issue-456': 'CCC-DDD' }

			vi.mocked(fs.readJson).mockImplementation(async () => ({ ...stored }))
			vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
			vi.mocked(fs.writeJson).mockImplementation(async (_path: string, data: unknown) => {
				stored = data as Record<string, string>
			})

			await clearTrackedSimulator('issue-123')

			expect(stored['issue-123']).toBeUndefined()
			expect(stored['issue-456']).toBe('CCC-DDD')
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		}
	})
})

// --- Platform Guard Behavior (parameterized) ---

describe('platform guard behavior', () => {
	const functionsToTest = [
		{ name: 'listSimulators', fn: () => listSimulators() },
		{ name: 'bootSimulator', fn: () => bootSimulator('AAA') },
		{ name: 'shutdownSimulator', fn: () => shutdownSimulator('AAA') },
		{ name: 'installApp', fn: () => installApp('AAA', '/path.app') },
		{ name: 'launchApp', fn: () => launchApp('AAA', 'com.example') },
		{ name: 'buildForSimulator', fn: () => buildForSimulator({ scheme: 'X' }) },
		{ name: 'buildForDevice', fn: () => buildForDevice({ scheme: 'X', developmentTeam: 'T' }) },
		{ name: 'listConnectedDevices', fn: () => listConnectedDevices() },
	]

	it.each(functionsToTest)(
		'$name throws on non-macOS',
		async ({ fn }) => {
			const originalPlatform = process.platform
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
			try {
				await expect(fn()).rejects.toThrow('iOS development tools are only available on macOS')
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
			}
		}
	)
})
