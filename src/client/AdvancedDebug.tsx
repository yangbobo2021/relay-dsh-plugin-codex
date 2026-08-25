import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import css from './AdvancedDebug.module.css'
import { statusLocaleKey } from './codex-status-client.mjs'
import { useCodexStatus } from './CodexStatus.tsx'

export interface AdvancedDebugSource {
  getSnapshot: () => boolean
  subscribe: (listener: () => void) => () => void
}

export interface AdvancedDebugInjected {
  hooks: { advancedDebug: AdvancedDebugSource }
  setAdvancedDebug: (enabled: boolean) => void
}

type AdvancedDebugSectionProps = PropsRuntime<'settings.section'>
  & InjectFace<AdvancedDebugInjected>
  & PropsLocale<'relay.codex'>

type AdvancedDebugGuardProps = PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<Pick<AdvancedDebugInjected, 'hooks'>>

export function AdvancedDebugSection({
  useAdvancedDebug, setAdvancedDebug, t,
}: AdvancedDebugSectionProps): ReactNode {
  const enabled = useAdvancedDebug(value => value)
  const codexStatus = useCodexStatus()
  return (
    <section className={css.section}>
      <div className={css.statusRow} data-codex-status={codexStatus?.state ?? 'loading'}>
        <span className={css.statusDot} aria-hidden="true" />
        <div className={css.settingCopy}>
          <strong>{t('statusTitle')}: {t(statusLocaleKey(codexStatus))}</strong>
          <span>{codexStatus === null ? t('statusLoadingDetail') : `${codexStatus.message} ${codexStatus.action ?? ''}`.trim()}</span>
          {codexStatus !== null && <code>{codexStatus.code}</code>}
        </div>
      </div>
      <div className={css.settingRow}>
        <div className={css.settingCopy}>
          <strong>{t('advancedDebug')}</strong>
          <span>{t('advancedDebugDetail')}</span>
        </div>
        <label className={css.switch}>
          <input
            type="checkbox"
            role="switch"
            aria-label={t('advancedDebug')}
            checked={enabled}
            onChange={event => { setAdvancedDebug(event.currentTarget.checked) }}
          />
          <span aria-hidden="true" />
        </label>
      </div>
    </section>
  )
}

export function AdvancedDebugGuard({ useAdvancedDebug }: AdvancedDebugGuardProps): ReactNode {
  const enabled = useAdvancedDebug(value => value)
  const marker = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const header = marker.current?.closest('header')
    if (header === undefined || header === null) return
    if (enabled) {
      header.removeAttribute('data-relay-simple-conversation')
    } else {
      // This additive header slot has no view-store API, so keep DSH as the
      // state owner by dispatching through its native first (Chat) tab.
      const selectChat = (): void => {
        const chatTab = header.querySelector<HTMLButtonElement>('[role="tablist"] [role="tab"]')
        if (chatTab?.getAttribute('aria-selected') !== 'true') chatTab?.click()
      }
      selectChat()
      header.setAttribute('data-relay-simple-conversation', 'true')
      const observer = new MutationObserver(selectChat)
      observer.observe(header, {
        attributes: true,
        attributeFilter: ['aria-selected'],
        childList: true,
        subtree: true,
      })
      return () => {
        observer.disconnect()
        header.removeAttribute('data-relay-simple-conversation')
      }
    }
    return () => { header.removeAttribute('data-relay-simple-conversation') }
  }, [enabled])

  return <span ref={marker} className={css.marker} aria-hidden="true" />
}

export function HiddenSessionLogAction(): null {
  return null
}
