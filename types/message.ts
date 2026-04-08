export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type AssistantMessage = {
  type: 'assistant'
  uuid: string
  timestamp?: string
  message: {
    id?: string
    role: 'assistant'
    content: MessageBlock[]
    usage?: Record<string, number>
    model?: string
    stop_reason?: string | null
    stop_sequence?: string | null
    type?: string
    context_management?: unknown
    [key: string]: unknown
  }
  requestId?: string
  isApiErrorMessage?: boolean
  apiError?: unknown
  error?: unknown
  errorDetails?: string
  isMeta?: boolean
  isVirtual?: boolean
  advisorModel?: string
}

export type UserMessage = {
  type: 'user'
  uuid: string
  timestamp?: string
  message: {
    role: 'user'
    content: MessageBlock[] | string
  }
  toolUseResult?: unknown
  sourceToolAssistantUUID?: string
  isMeta?: boolean
  isVisibleInTranscriptOnly?: boolean
  isVirtual?: boolean
  isCompactSummary?: boolean
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  permissionMode?: string
  origin?: MessageOrigin
}

export type SystemMessage = {
  type: 'system'
  uuid: string
  timestamp?: string
  message?: {
    role: 'system'
    content: string
  }
  subtype?: string
  content?: string
  isMeta?: boolean
  level?: SystemMessageLevel
  [key: string]: unknown
}

export type AttachmentMessage = {
  type: 'attachment'
  uuid: string
  timestamp?: string
  attachment: Record<string, unknown>
  message: {
    role: 'user'
    content: MessageBlock[] | string
  }
  isMeta?: boolean
  isVirtual?: boolean
  origin?: MessageOrigin
}

export type TombstoneMessage = {
  type: 'tombstone'
  message: Message
}

export type ToolUseSummaryMessage = {
  type: 'tool_use_summary'
  summary: string
}

/** Used in responsesWebSocket adapter for OpenAI-specific error signaling */
export type SystemAPIErrorMessage = {
  type: 'system_api_error'
  message: {
    content: string
    error?: string
  }
}

export type RequestStartEvent = {
  type: 'stream_request_start'
}

export type Message = UserMessage | AssistantMessage | SystemMessage | AttachmentMessage

export type StreamEvent =
  | RequestStartEvent
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; tool_use_id: string; delta: string }
  | { type: 'response_id'; id: string }

// ─── Progress messages ───────────────────────────────────────────────────────

export type ProgressMessage<P = unknown> = {
  type: 'progress'
  uuid: string
  timestamp: string
  toolUseID: string
  parentToolUseID: string
  data: P
}

// ─── Normalized message variants (single content-block) ──────────────────────

export type NormalizedAssistantMessage = AssistantMessage & {
  message: AssistantMessage['message'] & { content: [MessageBlock] }
}

export type NormalizedUserMessage = UserMessage & {
  message: { role: 'user'; content: MessageBlock[] }
}

export type NormalizedMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage

// ─── MessageOrigin ────────────────────────────────────────────────────────────

export type MessageOrigin =
  | { kind: 'task-notification' }
  | { kind: 'coordinator' }
  | { kind: 'channel'; server: string }
  | { kind: 'human' }

// ─── PartialCompactDirection ──────────────────────────────────────────────────

export type PartialCompactDirection = 'from' | 'up_to'

// ─── SystemMessageLevel ───────────────────────────────────────────────────────

export type SystemMessageLevel = 'info' | 'warning' | 'warn' | 'error' | 'success' | 'debug'

// ─── StopHookInfo ─────────────────────────────────────────────────────────────

export type StopHookInfo = {
  command: string
  durationMs: number
}

// ─── System message subtypes ──────────────────────────────────────────────────

type SystemMessageBase = {
  type: 'system'
  uuid: string
  timestamp: string
  isMeta: boolean
}

export type SystemInformationalMessage = SystemMessageBase & {
  subtype: 'informational'
  content: string
  level: SystemMessageLevel
  toolUseID?: string
  preventContinuation?: boolean
}

export type SystemPermissionRetryMessage = SystemMessageBase & {
  subtype: 'permission_retry'
  content: string
  commands: string[]
  level: SystemMessageLevel
}

export type SystemBridgeStatusMessage = SystemMessageBase & {
  subtype: 'bridge_status'
  content: string
  url: string
  upgradeNudge?: string
}

export type SystemScheduledTaskFireMessage = SystemMessageBase & {
  subtype: 'scheduled_task_fire'
  content: string
}

export type SystemStopHookSummaryMessage = SystemMessageBase & {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason?: string
  hasOutput: boolean
  level: SystemMessageLevel
  toolUseID?: string
  hookLabel?: string
  totalDurationMs?: number
}

export type SystemTurnDurationMessage = SystemMessageBase & {
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

export type SystemAwaySummaryMessage = SystemMessageBase & {
  subtype: 'away_summary'
  content: string
}

export type SystemMemorySavedMessage = SystemMessageBase & {
  subtype: 'memory_saved'
  writtenPaths: string[]
  teamCount?: number
}

export type SystemAgentsKilledMessage = SystemMessageBase & {
  subtype: 'agents_killed'
}

export type SystemApiMetricsMessage = SystemMessageBase & {
  subtype: 'api_metrics'
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

export type SystemLocalCommandMessage = SystemMessageBase & {
  subtype: 'local_command'
  content: string
  level: SystemMessageLevel
}

export type CompactMetadata = {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
  preservedSegment?: {
    headUuid: string
    anchorUuid: string
    tailUuid: string
  }
}

export type SystemCompactBoundaryMessage = SystemMessageBase & {
  subtype: 'compact_boundary'
  content: string
  level: SystemMessageLevel
  compactMetadata: CompactMetadata
  logicalParentUuid?: string
}

export type SystemMicrocompactBoundaryMessage = SystemMessageBase & {
  subtype: 'microcompact_boundary'
  content: string
  level: SystemMessageLevel
  microcompactMetadata: {
    trigger: 'auto'
    preTokens: number
    tokensSaved: number
    compactedToolIds: string[]
    clearedAttachmentUUIDs: string[]
  }
}

// ─── Hook-related message types ───────────────────────────────────────────────

/** A message produced by a hook (SessionStart, PreToolUse, etc.) */
export type HookResultMessage = AttachmentMessage | UserMessage

// ─── Renderable / collapsed message types ─────────────────────────────────────

export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  uuid: string
  timestamp: string
  searchCount: number
  readCount: number
  listCount: number
  memorySearchCount?: number
  memoryReadCount?: number
  memoryWriteCount?: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint?: unknown
  messages: NormalizedMessage[]
  displayMessage: NormalizedMessage
  replCount?: number
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: unknown[]
  pushes?: unknown[]
  branches?: unknown[]
  prs?: unknown[]
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
}

export type CollapsibleMessage = NormalizedAssistantMessage | CollapsedReadSearchGroup

export type RenderableMessage =
  | NormalizedMessage
  | CollapsedReadSearchGroup
  | { type: 'grouped_tool_use'; toolName: string; messages: NormalizedAssistantMessage[]; uuid: string; timestamp: string }
