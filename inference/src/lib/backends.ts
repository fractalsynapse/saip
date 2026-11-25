/**
 * Injectable backend seams for the inference gateway.
 *
 * External systems (object storage, the vLLM engine) are reached only through these interfaces so
 * plugins never import a concrete client. Fake implementations make every endpoint testable
 * without a GPU or network. Object storage is the exception to the rule below: its contract is
 * shared with the training gateway rather than declared here, see `@saip/shared/storage`.
 */

import type { Message } from './config.js'

/**
 * The storage contract lives in `@saip/shared/storage` (#198) because training reads exactly the
 * keys inference writes: two independently-declared interfaces drift, and drift here means a
 * training job that silently sees nothing. `MemoryStorage` moved with it — it is a test double and
 * an explicit `SAIP_STORAGE=memory` opt-in, not a production default.
 *
 * Re-exported so no import site in this package had to change.
 */
export type { StorageProvider } from '@saip/shared/storage'
export { MemoryStorage, storageProviderFor } from '@saip/shared/storage'

// ─── vLLM backend seam ────────────────────────────────────────

export interface VllmChatRequest {
  model: string
  messages: Message[]
  temperature?: number
  max_tokens?: number
  top_p?: number
  stop?: string | string[]
}

export interface VllmChatResponse {
  id: string
  created: number
  model: string
  choices: Array<{ index: number; message: Message; finish_reason: string }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

/** One parsed `chat.completion.chunk` from the engine. */
export interface VllmStreamChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices: Array<{
    index: number
    delta?: { role?: string; content?: string; tool_calls?: unknown }
    message?: Message
    finish_reason?: string | null
  }>
  usage?: VllmChatResponse['usage'] | null
}

export interface VllmBackend {
  chat(req: VllmChatRequest): Promise<VllmChatResponse>
  /**
   * Optional streaming. Yields parsed chunk OBJECTS; the route serializes them into SSE
   * frames, so an implementation must not pre-format `data:` lines — that would
   * double-encode. The engine's `[DONE]` sentinel ends the iteration and is never yielded;
   * the caller emits it.
   */
  stream?(req: VllmChatRequest): AsyncIterable<VllmStreamChunk>
}
