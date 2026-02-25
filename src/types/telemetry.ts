// --- Config schema ---
export interface TelemetryConfig {
  enabled: boolean
  disclosed_at?: string // ISO 8601 timestamp
  last_version?: string // e.g., "0.9.2"
}

// --- Base event properties (auto-added by TelemetryService) ---
// source: "cli" is added automatically; not in per-event interfaces

// --- Event payload interfaces (14 events from #664) ---

export interface CliInstalledProperties {
  version: string
  os: string
  node_version: string
}

export interface CliUpgradedProperties {
  version: string
  previous_version: string
  os: string
}

export interface LoomCreatedProperties {
  source_type: 'issue' | 'pr' | 'branch' | 'freeform'
  tracker: string // 'github' | 'linear' | 'jira' | 'bitbucket'
  is_child_loom: boolean
  one_shot_mode: 'default' | 'skip-reviews' | 'yolo'
}

export interface LoomFinishedProperties {
  merge_behavior: 'local' | 'github-pr' | 'github-draft-pr'
  duration_minutes: number
}

export interface LoomAbandonedProperties {
  duration_minutes: number
  phase_reached: string
}

export interface EpicPlannedProperties {
  child_count: number
  tracker: string
}

export interface SwarmStartedProperties {
  child_count: number
  tracker: string
}

export interface SwarmChildCompletedProperties {
  success: boolean
  duration_minutes: number
}

export interface SwarmCompletedProperties {
  total_children: number
  succeeded: number
  failed: number
  duration_minutes: number
}

export interface DemoStartedProperties {
  path: string // 'issue' | 'pr' | 'epic'
}

export interface DemoCompletedProperties {
  path: string
  converted_to_real_project: boolean
}

export interface ContributeStartedProperties {
  tracker: string
}

export interface SessionStartedProperties {
  has_neon: boolean
  language: string
}

export interface ErrorOccurredProperties {
  error_type: string
  command: string
  phase: string
}

export interface InitStartedProperties {
  mode: 'accept-defaults' | 'guided' | 'guided-custom-prompt'
}

export interface InitCompletedProperties {
  mode: 'accept-defaults' | 'guided' | 'guided-custom-prompt'
}

export interface AutoSwarmStartedProperties {
  source: 'decomposition' | 'fresh'
  planner: string // 'claude' | 'gemini' | 'codex'
}

export interface AutoSwarmCompletedProperties {
  source: 'decomposition' | 'fresh'
  success: boolean
  child_count: number
  duration_minutes: number
  phase_reached: 'plan' | 'start' | 'spin'
  fallback_to_normal: boolean
}

// --- Event name → properties map (for type-safe track() in downstream issues) ---
export interface TelemetryEventMap {
  'cli.installed': CliInstalledProperties
  'cli.upgraded': CliUpgradedProperties
  'loom.created': LoomCreatedProperties
  'loom.finished': LoomFinishedProperties
  'loom.abandoned': LoomAbandonedProperties
  'epic.planned': EpicPlannedProperties
  'swarm.started': SwarmStartedProperties
  'swarm.child_completed': SwarmChildCompletedProperties
  'swarm.completed': SwarmCompletedProperties
  'demo.started': DemoStartedProperties
  'demo.completed': DemoCompletedProperties
  'contribute.started': ContributeStartedProperties
  'session.started': SessionStartedProperties
  'error.occurred': ErrorOccurredProperties
  'init.started': InitStartedProperties
  'init.completed': InitCompletedProperties
  'auto_swarm.started': AutoSwarmStartedProperties
  'auto_swarm.completed': AutoSwarmCompletedProperties
}

export type TelemetryEventName = keyof TelemetryEventMap
