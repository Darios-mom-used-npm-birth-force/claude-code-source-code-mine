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
      name: tool.name,
      description: typeof tool.description === 'function'
        ? (tool.description as unknown as (input: unknown, opts: unknown) => Promise<string>).toString()
        : String(tool.description ?? ''),
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

  return yield* await new Promise<AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>>((resolve, reject) => {
    const isBun = typeof Bun !== 'undefined'
    let wsNode: WsWebSocket | null = null
    let wsBun: globalThis.WebSocket | null = null

    // Create the WebSocket using the correct runtime-specific API
    if (isBun) {
      // Bun's native WebSocket supports headers via options object
      const ws = new globalThis.WebSocket(wsUrl.toString(), {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      } as unknown as string[])
      wsBun = ws
    } else {
      // Node.js: use the `ws` library which supports headers
      import('ws').then(({ default: WS }) => {
        const ws = new WS(wsUrl.toString(), {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        })
        wsNode = ws
        attachNodeHandlers(ws)
      }).catch(reject)
    }

    let isDone = false
    let currentAssistantMessage: AssistantMessage | null = null
    const toolCallBuffers = new Map<string, { name: string, args: string }>()

    // Close the socket when the AbortSignal fires
    signal.addEventListener('abort', () => {
      isDone = true
      try { wsNode?.close() } catch (_) {}
      try { wsBun?.close() } catch (_) {}
      if (pendingResolveRef) {
        pendingResolveRef(true)
        pendingResolveRef = null
      }
    })

    let pendingResolveRef: ((value: unknown) => void) | null = null
    let pendingRejectRef: ((reason?: unknown) => void) | null = null
    const eventQueue: unknown[] = []

    function handleMessage(data: string): void {
      try {
        const parsed = JSON.parse(data)
        eventQueue.push(parsed)
        if (pendingResolveRef) {
          pendingResolveRef(true)
          pendingResolveRef = null
        }
      } catch (_) {}
    }

    function handleClose(): void {
      isDone = true
      if (pendingResolveRef) {
        pendingResolveRef(true)
        pendingResolveRef = null
      }
    }

    function handleError(err: unknown): void {
      if (pendingRejectRef) {
        pendingRejectRef(err)
        pendingRejectRef = null
      }
    }

    function sendPayload(sendFn: (data: string) => void): void {
      // Map messages directly into input items
      // `query.ts` handles slicing out already-sent messages when previousResponseId is set
      const inputItems = messages.flatMap(m => {
        if (m.type === 'user' && m.message.content) {
          const content = Array.isArray(m.message.content)
            ? m.message.content
            : [{ type: 'text', text: m.message.content }]

          // Map content items to OpenAI equivalents
          const mappedContent = content.map(c => {
            if (c.type === 'tool_result') {
              return {
                type: 'function_call_output',
                call_id: c.tool_use_id,
                output: c.content || '',
              }
            }
            return { type: 'input_text', text: typeof c === 'string' ? c : (c as { text?: string }).text ?? '' }
          })

          // function_call_outputs are top-level items; user text becomes a message
          return mappedContent.map(mc => {
            if (mc.type === 'function_call_output') {
              return mc
            }
            return { type: 'message', role: 'user', content: [mc] }
          })
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

      sendFn(JSON.stringify(payload))
    }

    function attachNodeHandlers(ws: WsWebSocket): void {
      ws.on('open', () => sendPayload(data => ws.send(data)))
      ws.on('message', (data: unknown) => handleMessage(String(data)))
      ws.on('close', handleClose)
      ws.on('error', handleError)
    }

    if (isBun && wsBun) {
      wsBun.addEventListener('open', () => sendPayload(data => wsBun!.send(data)))
      wsBun.addEventListener('message', (event: MessageEvent) => handleMessage(String(event.data)))
      wsBun.addEventListener('close', handleClose)
      wsBun.addEventListener('error', handleError)
    }

    const stream = (async function* (): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
      while (!isDone || eventQueue.length > 0) {
        if (eventQueue.length === 0) {
          await new Promise((res, rej) => {
            pendingResolveRef = res
            pendingRejectRef = rej
          })
        }

        const event = eventQueue.shift() as Record<string, unknown> | undefined
        if (!event) continue

        // Handle the 53 events here
        switch (event.type) {
          case 'response.created':
            // Yield response ID to be captured in query.ts
            yield { type: 'response_id', id: (event.response as Record<string, unknown>).id } as StreamEvent
            break

          case 'response.output_item.added': {
            const item = event.item as Record<string, unknown>
            if (!currentAssistantMessage) {
              currentAssistantMessage = {
                type: 'assistant',
                uuid: String(item.id || randomUUID()),
                message: {
                  role: 'assistant',
                  content: [],
                },
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
              // Yield the updated AssistantMessage immediately so toolExecutor sees it
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
              // Yield a tool_call_delta stream event
              yield { type: 'tool_call_delta', tool_use_id: String(event.call_id), delta: String(event.delta) } as StreamEvent
            }
            break
          }

          case 'function_call_arguments.done': {
            const doneBuffer = toolCallBuffers.get(String(event.call_id))
            if (doneBuffer && currentAssistantMessage) {
              // Update the in-memory AssistantMessage reference
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
    })()

    resolve(stream)
  })
}
