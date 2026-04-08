export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type AssistantMessage = {
  type: 'assistant'
  uuid: string
  message: {
    role: 'assistant'
    content: MessageBlock[]
    usage?: Record<string, number>
  }
  isApiErrorMessage?: boolean
  apiError?: string
}

export type UserMessage = {
  type: 'user'
  uuid: string
  message: {
    role: 'user'
    content: MessageBlock[] | string
  }
  toolUseResult?: string
  sourceToolAssistantUUID?: string
  isMeta?: boolean
}

export type SystemMessage = {
  type: 'system'
  uuid: string
  message: {
    role: 'system'
    content: string
  }
}

export type AttachmentMessage = {
  type: 'attachment'
  uuid: string
  attachment: any
  message: {
    role: 'user'
    content: MessageBlock[] | string
  }
}

export type TombstoneMessage = {
  type: 'tombstone'
  message: Message
}

export type ToolUseSummaryMessage = {
  type: 'tool_use_summary'
  summary: string
}

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
