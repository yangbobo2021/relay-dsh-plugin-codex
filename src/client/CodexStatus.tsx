import { useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchCodexStatus, statusLocaleKey, type CodexConnectionStatus } from './codex-status-client.mjs'
import css from './AdvancedDebug.module.css'

interface EmptyInjected {}

type CodexStatusBadgeProps = PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'relay.codex'>
  & InjectFace<EmptyInjected>

export function useCodexStatus(sessionId?: string, enabled = true): CodexConnectionStatus | null {
  const [status, setStatus] = useState<CodexConnectionStatus | null>(null)
  useEffect(() => {
    if (!enabled) {
      setStatus(null)
      return
    }
    let active = true
    const refresh = (): void => {
      void fetchCodexStatus(sessionId).then(value => {
        if (active) setStatus(value)
      }).catch(() => {
        if (active) setStatus({
          state: 'connection-failed',
          code: 'CODEX_STATUS_UNAVAILABLE',
          message: 'DSH could not read Codex connection status.',
          action: 'Restart DSH and try again.',
          changedAt: Date.now(),
        })
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [sessionId, enabled])
  return status
}

export function CodexStatusBadge({ sessionId, useSessions, t }: CodexStatusBadgeProps): ReactNode {
  const preset = useSessions(state => state.byId[sessionId]?.agentPreset)
  const status = useCodexStatus(String(sessionId), preset === 'relay-codex')
  if (preset !== 'relay-codex' || status === null || status.state === 'connected') return null
  return (
    <span
      className={`${css.statusBadge} ${status.state === 'rebind-required' ? css.statusRebind : css.statusError}`}
      title={`${status.message} ${status.action ?? ''}`.trim()}
      data-codex-status={status.state}
    >
      {t(statusLocaleKey(status))}
    </span>
  )
}
