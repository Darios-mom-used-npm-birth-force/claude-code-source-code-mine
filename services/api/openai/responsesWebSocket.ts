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
import type { ThinkingConfig } from '../../../utils/context.js'
import WebSocket from 'ws'
import { randomUUID } from 'crypto'

function mapAnthropicToolsToOpenAI(tools: Tools) {
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: tool.schema?.shape || {}, // Mock, would need proper Zod to JSON Schema conversion
      additionalProperties: false,
      required: Object.keys(tool.schema?.shape || {})
    }
  }))
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
  const previous_response_id = (options as any).previous_response_id || undefined

  return yield* await new Promise<AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>>((resolve, reject) => {
    let ws: WebSocket

    // Fallback to basic WebSocket if not in Node env
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      ws = new WebSocket(wsUrl.toString(), {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
    } else {
      ws = new (globalThis as any).WebSocket(wsUrl.toString(), ['Bearer', apiKey])
    }

    let isDone = false
    let currentAssistantMessage: AssistantMessage | null = null
    const toolCallBuffers = new Map<string, { name: string, args: string }>()

    const stream = (async function* () {
      let pendingResolve: ((value: any) => void) | null = null
      let pendingReject: ((reason?: any) => void) | null = null
      const eventQueue: any[] = []

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data.toString())
        eventQueue.push(data)
        if (pendingResolve) {
          pendingResolve(true)
          pendingResolve = null
        }
      }

      ws.onclose = () => {
        isDone = true
        if (pendingResolve) {
          pendingResolve(true)
          pendingResolve = null
        }
      }

      ws.onerror = (err) => {
        if (pendingReject) {
          pendingReject(err)
          pendingReject = null
        }
      }

      // Initial request payload
      ws.onopen = () => {
        // Map messages directly into input items
        // `query.ts` handles slicing out already-sent messages when previous_response_id is set
        const inputItems = messages.map(m => {
          if (m.type === 'user' && m.message.content) {
            const content = Array.isArray(m.message.content) ? m.message.content : [{ type: 'text', text: m.message.content }]

            // Map content items to OpenAI equivalents
            const mappedContent = content.map(c => {
              if (c.type === 'tool_result') {
                return {
                  type: 'function_call_output',
                  call_id: c.tool_use_id,
                  output: c.content || ''
                }
              }
              return { type: 'input_text', text: typeof c === 'string' ? c : (c as any).text || '' }
            })

            // If it's a mix of function_call_output and input_text, OpenAI wants function_call_outputs
            // as distinct top-level items, but for now we'll structure what we can
            // In a full implementation, `inputItems` should be unrolled
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
            content: typeof m.message.content === 'string' ?
              [{ type: 'input_text', text: m.message.content }] :
              m.message.content.map(c => ({ type: 'input_text', text: JSON.stringify(c) }))
          }]
        }).flat()

        const payload: any = {
          type: 'response.create',
          model: options.model || 'gpt-4o',
          store: false,
          instructions: systemPrompt.map(p => p.text).join('\n'),
          tools: mapAnthropicToolsToOpenAI(tools),
          input: inputItems,
          context_management: [{ type: "compaction", compact_threshold: 200000 }]
        }

        if (previous_response_id) {
          payload.previous_response_id = previous_response_id
        }

        ws.send(JSON.stringify(payload))
      }

      while (!isDone || eventQueue.length > 0) {
        if (eventQueue.length === 0) {
          await new Promise((res, rej) => {
            pendingResolve = res
            pendingReject = rej
          })
        }

        const event = eventQueue.shift()
        if (!event) continue

        // Handle the 53 events here
        switch (event.type) {
          case 'response.created':
            // Yield response ID to be captured in query.ts
            yield { type: 'response_id', id: event.response.id } as StreamEvent
            break

          case 'response.output_item.added':
            if (!currentAssistantMessage) {
              currentAssistantMessage = {
                type: 'assistant',
                uuid: event.item.id || 'assistant-message-' + randomUUID(),
                message: {
                  role: 'assistant',
                  content: []
                }
              }
            }
            if (event.item.type === 'function_call') {
              toolCallBuffers.set(event.item.call_id, { name: event.item.name, args: '' })
              currentAssistantMessage.message.content.push({
                type: 'tool_use',
                id: event.item.call_id,
                name: event.item.name,
                input: {}
              })
              // Yield the updated AssistantMessage immediately so toolExecutor sees it
              yield currentAssistantMessage
            }
            break

          case 'output_text.delta':
            if (currentAssistantMessage) {
              const textBlock = currentAssistantMessage.message.content.find(c => c.type === 'text') as any
              if (textBlock) {
                textBlock.text += event.delta
              } else {
                currentAssistantMessage.message.content.push({ type: 'text', text: event.delta })
              }
            }
            yield { type: 'text_delta', text: event.delta } as StreamEvent
            break

          case 'function_call_arguments.delta':
            const buffer = toolCallBuffers.get(event.call_id)
            if (buffer) {
              buffer.args += event.delta
              // Yield a tool_call_delta stream event
              yield { type: 'tool_call_delta', tool_use_id: event.call_id, delta: event.delta } as StreamEvent
            }
            break

          case 'function_call_arguments.done':
            const doneBuffer = toolCallBuffers.get(event.call_id)
            if (doneBuffer && currentAssistantMessage) {
              // Update the in-memory AssistantMessage reference
              const toolBlock = currentAssistantMessage.message.content.find((c: any) => c.type === 'tool_use' && c.id === event.call_id) as any
              if (toolBlock) {
                try {
                  toolBlock.input = JSON.parse(doneBuffer.args || '{}')
                } catch(e) {
                  toolBlock.input = {}
                }
              }
            }
            break

          case 'response.completed':
            if (currentAssistantMessage) {
              currentAssistantMessage.message.usage = event.response.usage
              yield currentAssistantMessage
            }
            break
        }
      }
    })()

    resolve(stream)
  })
}
