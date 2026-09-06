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
  complexity_override: boolean
  create_only: boolean
}

export interface LoomFinishedProperties {
  merge_behavior: 'local' | 'pr' | 'draft-pr'
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
  effort?: import('./index.js').EffortLevel
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

export interface EpicReportGeneratedProperties {
  total_children: number
  succeeded: number
  failed: number
}

export interface DevServerStartedEvent {
  /** Execution mode for the dev server */
  mode: 'docker' | 'process'
  /** Whether the dev server started successfully */
  success: boolean
  /**
   * Time in milliseconds to build the Docker image.
   * Only present when mode is 'docker'.
   */
  buildDurationMs?: number
  /** Time in milliseconds from start to the server being ready */
  startDurationMs: number
  /**
   * Number of BuildKit secrets mounted during docker build.
   * Only present when mode is 'docker' and secrets are configured.
   * Tracks feature adoption without exposing secret IDs or paths.
   */
  docker_build_secrets_count?: number
}

export interface DevServerStoppedEvent {
  /** Execution mode for the dev server */
  mode: 'docker' | 'process'
  /** Reason the dev server stopped */
  reason: 'user' | 'cleanup' | 'error'
}

export interface RebaseStrategySelectedProperties {
  /** The strategy chosen for updating the branch */
  strategy: 'rebase' | 'merge'
  /** The reason the strategy was selected */
  reason: 'merge_commits' | 'commit_threshold' | 'always_merge' | 'default'
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
  'epic.report_generated': EpicReportGeneratedProperties
  'devServer.started': DevServerStartedEvent
  'devServer.stopped': DevServerStoppedEvent
  'rebase.strategy_selected': RebaseStrategySelectedProperties
}

export type TelemetryEventName = keyof TelemetryEventMap
