import { useState, type ChangeEvent } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodexCardFace, CodexRuntimeMode } from './codex-card-controller.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import css from './CodexCard.module.css'

export type CodexCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'relay.codex'>
  & InjectFace<CodexCardFace>

export function CodexCard(props: CodexCardProps) {
  const { t } = props
  const state = props.useCodexCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  return (
    <li className={css.card}>
      <button type="button" className={css.header} aria-expanded={open}
        aria-label={`${t(open ? 'runtimeCollapse' : 'runtimeExpand')}: ${t('runtimeTitle')}`}
        onClick={() => setOpen(value => !value)}>
        <span className={css.headText}>
          <span className={css.name}>{t('runtimeTitle')}</span>
          <span className={css.description}>{t('runtimeDescription')}</span>
        </span>
        {state.dirty ? <span className={css.badge}>{t('runtimeUnsaved')}</span> : null}
        <span className={css.chevron} aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {open ? <div className={css.body}>
        {!state.writable ? <p className={css.readOnly}>{t('runtimeReadOnly')}</p> : null}
        <div className={css.field}>
          <label className={css.label} htmlFor="relay-codex-runtime-mode">{t('runtimeMode')}</label>
          <select id="relay-codex-runtime-mode" className={css.select} value={state.mode}
            disabled={disabled} onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              props.setMode(event.target.value as CodexRuntimeMode)
            }}>
            <option value="auto">{t('runtimeAuto')}</option>
            <option value="bundled">{t('runtimeBundled')}</option>
            <option value="path">{t('runtimePath')}</option>
          </select>
          <p className={css.hint}>{t('runtimeModeHint')}</p>
        </div>
        {state.mode === 'path' ? <div className={css.field}>
          <div className={css.badges}>
            <label className={css.label} htmlFor="relay-codex-runtime-path">{t('runtimePathLabel')}</label>
            {state.overridden ? <><span className={css.badge}>{t('runtimeOverridden')}</span><button type="button" className={css.reset} disabled={disabled} onClick={props.reset}>{t('runtimeReset')}</button></> : null}
          </div>
          <input id="relay-codex-runtime-path" className={css.input} value={state.path}
            disabled={disabled} placeholder={t('runtimePathPlaceholder')} onChange={(event) => props.editPath(event.target.value)} />
          <p className={state.invalid ? css.error : css.hint}>{state.invalid ? t('runtimePathRequired') : t('runtimePathHint')}</p>
        </div> : null}
        {state.mode !== 'path' && state.overridden ? <div className={css.field}>
          <div className={css.badges}><span className={css.badge}>{t('runtimeOverridden')}</span><button type="button" className={css.reset} disabled={disabled} onClick={props.reset}>{t('runtimeReset')}</button></div>
        </div> : null}
        <p className={css.hint}>{t('runtimeRestartHint')}</p>
        <div className={css.footer}>
          {state.failed ? <p className={css.failed}>{t('runtimeSaveFailed')}</p> : null}
          <button type="button" className={css.discard} disabled={!state.dirty || state.saving} onClick={props.discard}>{t('runtimeDiscard')}</button>
          <button type="button" className={css.save} disabled={!state.dirty || state.invalid || state.saving} onClick={props.save}>{state.saving ? t('runtimeSaving') : t('runtimeSave')}</button>
        </div>
      </div> : null}
    </li>
  )
}
