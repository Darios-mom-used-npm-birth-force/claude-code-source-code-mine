import { randomUUID } from 'crypto'
import type WsWebSocket from 'ws'
import type {
  Message,
  StreamEvent,
  AssistantMessage,
  SystemAPIErrorMessage,
  MessageBlock
} from '../../../types/message.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { Tools } from '../../../Tool.js'
import type { Options } from '../claude.js'
import type { ThinkingConfig } from '../../../utils/thinking.js'

function mapAnthropicToolsToOpenAI(tools: Tools) {
  return tools.map(tool => {
    // Prefer explicit JSON Schema if available (MCP tools), otherwise derive from Zod schema
    const inputSchema: Record<string, unknown> = tool.inputJSONSchema
      ? { ...tool.inputJSONSchema }
      : {
          type: 'object',
          properties: {},
          additionalProperties: false,
          required: [],
        }
    return {
      type: 'function',
      // Use the tool name as a stable identifier; description() is async and
      // requires tool input to compute — not available at registration time.
      name: tool.name,
      description: tool.name,
      parameters: inputSchema,
    }
  })
}

export async function* queryModelWithWebSocket({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    yield {
      type: 'system_api_error',
      message: {
        content: 'OPENAI_API_KEY environment variable is missing.',
        error: 'invalid_api_key'
      }
    } as SystemAPIErrorMessage
    return
  }

  const wsUrl = new URL('wss://api.openai.com/v1/responses')

  // Try to use a stored response ID if we have one in options for incremental context
  const previousResponseId = (options as any).previousResponseId || undefined

  const isBun = typeof Bun !== 'undefined'

  // Create the WebSocket eagerly so handlers can be attached synchronously
  let wsNode: WsWebSocket | null = null
  let wsBun: globalThis.WebSocket | null = null

  if (isBun) {
    // Bun's native WebSocket supports headers via options object
    wsBun = new globalThis.WebSocket(wsUrl.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    } as unknown as string[])
  } else {
    // Node.js: use the `ws` library (supports headers) — await so the socket
    // is ready before the async generator body begins yielding.
    const { default: WS } = await import('ws')
    wsNode = new WS(wsUrl.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
  }

  let isDone = false
  let currentAssistantMessage: AssistantMessage | null = null
  const toolCallBuffers = new Map<string, { name: string, args: string }>()

  // Shared queue state
  const eventQueue: unknown[] = []
  let pendingResolveRef: ((value: unknown) => void) | null = null

  function handleMessage(data: string): void {
    try {
      eventQueue.push(JSON.parse(data))
      if (pendingResolveRef) {
        const resolve = pendingResolveRef
        pendingResolveRef = null
        resolve(true)
      }
    } catch (_) {}
  }

  function handleClose(): void {
    isDone = true
    if (pendingResolveRef) {
      const resolve = pendingResolveRef
      pendingResolveRef = null
      resolve(true)
    }
  }

  function handleError(err: unknown): void {
    isDone = true
    if (pendingResolveRef) {
      const resolve = pendingResolveRef
      pendingResolveRef = null
      resolve(err)
    }
  }

  function buildPayload(): Record<string, unknown> {
    const inputItems = messages.flatMap(m => {
      if (m.type === 'user' && m.message.content) {
        const content = Array.isArray(m.message.content)
          ? m.message.content
          : [{ type: 'text', text: m.message.content }]

        const mappedContent = content.map(c => {
          if (c.type === 'tool_result') {
            return { type: 'function_call_output', call_id: c.tool_use_id, output: c.content || '' }
          }
          return { type: 'input_text', text: typeof c === 'string' ? c : (c as { text?: string }).text ?? '' }
        })

        return mappedContent.map(mc =>
          mc.type === 'function_call_output'
            ? mc
            : { type: 'message', role: 'user', content: [mc] },
        )
      }

      return [{
        type: 'message',
        role: m.message.role,
        content: typeof m.message.content === 'string'
          ? [{ type: 'input_text', text: m.message.content }]
          : m.message.content.map(c => ({ type: 'input_text', text: JSON.stringify(c) })),
      }]
    })

    const payload: Record<string, unknown> = {
      type: 'response.create',
      model: options.model || 'gpt-4o',
      store: false,
      instructions: systemPrompt.join('\n'),
      tools: mapAnthropicToolsToOpenAI(tools),
      input: inputItems,
      context_management: [{ type: 'compaction', compact_threshold: 200000 }],
    }
    if (previousResponseId) {
      payload.previous_response_id = previousResponseId
    }
    return payload
  }

  if (isBun && wsBun) {
    wsBun.addEventListener('open', () => wsBun!.send(JSON.stringify(buildPayload())))
    wsBun.addEventListener('message', (event: MessageEvent) => handleMessage(String(event.data)))
    wsBun.addEventListener('close', handleClose)
    wsBun.addEventListener('error', handleError)
  } else if (wsNode) {
    wsNode.on('open', () => wsNode!.send(JSON.stringify(buildPayload())))
    wsNode.on('message', (data: unknown) => handleMessage(String(data)))
    wsNode.on('close', handleClose)
    wsNode.on('error', handleError)
  }

  // Close the socket when the AbortSignal fires
  signal.addEventListener('abort', () => {
    isDone = true
    try { wsNode?.close() } catch (_) {}
    try { wsBun?.close() } catch (_) {}
    if (pendingResolveRef) {
      const resolve = pendingResolveRef
      pendingResolveRef = null
      resolve(true)
    }
  })

  // Stream events from the WebSocket
  while (!isDone || eventQueue.length > 0) {
    if (eventQueue.length === 0) {
      await new Promise(resolve => { pendingResolveRef = resolve })
    }

    const event = eventQueue.shift() as Record<string, unknown> | undefined
    if (!event) continue

    switch (event.type) {
      case 'response.created':
        yield { type: 'response_id', id: (event.response as Record<string, unknown>).id } as StreamEvent
        break

      case 'response.output_item.added': {
        const item = event.item as Record<string, unknown>
        if (!currentAssistantMessage) {
          currentAssistantMessage = {
            type: 'assistant',
            uuid: String(item.id || randomUUID()),
            message: { role: 'assistant', content: [] },
          }
        }
        if (item.type === 'function_call') {
          toolCallBuffers.set(String(item.call_id), { name: String(item.name), args: '' })
          currentAssistantMessage.message.content.push({
            type: 'tool_use',
            id: String(item.call_id),
            name: String(item.name),
            input: {},
          })
          yield currentAssistantMessage
        }
        break
      }

      case 'output_text.delta': {
        if (currentAssistantMessage) {
          const textBlock = currentAssistantMessage.message.content.find(c => c.type === 'text') as { text: string } | undefined
          if (textBlock) {
            textBlock.text += String(event.delta)
          } else {
            currentAssistantMessage.message.content.push({ type: 'text', text: String(event.delta) })
          }
        }
        yield { type: 'text_delta', text: String(event.delta) } as StreamEvent
        break
      }

      case 'function_call_arguments.delta': {
        const buffer = toolCallBuffers.get(String(event.call_id))
        if (buffer) {
          buffer.args += String(event.delta)
          yield { type: 'tool_call_delta', tool_use_id: String(event.call_id), delta: String(event.delta) } as StreamEvent
        }
        break
      }

      case 'function_call_arguments.done': {
        const doneBuffer = toolCallBuffers.get(String(event.call_id))
        if (doneBuffer && currentAssistantMessage) {
          const toolBlock = currentAssistantMessage.message.content.find(
            c => c.type === 'tool_use' && c.id === String(event.call_id),
          ) as MessageBlock & { input?: unknown } | undefined
          if (toolBlock) {
            try {
              (toolBlock as Record<string, unknown>).input = JSON.parse(doneBuffer.args || '{}')
            } catch (_) {
              (toolBlock as Record<string, unknown>).input = {}
            }
          }
        }
        break
      }

      case 'response.completed': {
        if (currentAssistantMessage) {
          currentAssistantMessage.message.usage = (event.response as Record<string, unknown>).usage as Record<string, number>
          yield currentAssistantMessage
        }
        break
      }
    }
  }
}
