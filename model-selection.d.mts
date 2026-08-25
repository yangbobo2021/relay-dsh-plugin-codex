import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

interface ModelSelectionConnection {
  api: { sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'> }
}

export type ModelSelectionContext = ClientContext & {
  get(name: 'connection'): ModelSelectionConnection
}

export function installModelSelection(
  ctx: ModelSelectionContext,
  preset: string,
  provider: string,
  otherProvider: string,
  options?: { retryDelaysMs?: readonly number[] },
): () => void
