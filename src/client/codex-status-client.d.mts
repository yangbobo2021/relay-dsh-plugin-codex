export interface CodexConnectionStatus {
  state: 'not-started' | 'starting' | 'connected' | 'connection-failed' | 'unavailable' | 'rebind-required'
  code: string
  message: string
  action: string | null
  changedAt: number
  details?: { threadId?: string | null; turnId?: string | null; itemId?: string | null }
}

export const CODEX_STATUS_PATH: string
export function fetchCodexStatus(
  sessionId?: string,
  fetchImpl?: typeof fetch,
): Promise<CodexConnectionStatus>
export function statusLocaleKey(status: CodexConnectionStatus | null):
  | 'statusLoading' | 'statusConnected' | 'statusNotStarted' | 'statusStarting'
  | 'statusRebindRequired' | 'statusUnavailable' | 'statusConnectionFailed'
