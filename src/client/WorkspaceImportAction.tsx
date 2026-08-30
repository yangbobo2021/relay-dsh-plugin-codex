import { useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconCodeOutline16,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { resolveImportWorkspace } from './workspace-import-client.mjs'
import {
  workspaceImportUpdatedAtDate,
  workspaceImportUiPolicy,
  type WorkspaceImportUiAction,
} from './workspace-import-ui-policy.mjs'
import css from './WorkspaceImportAction.module.css'

interface WorkspaceView {
  workspaceId: string
  title: string
  path: string
  sessionIds: readonly string[]
}

interface WorkspaceState {
  items: readonly WorkspaceView[]
  recentWorkspaceId?: string
}

interface SessionState {
  current?: string
}

interface Summary {
  found: number
  existing: number
  recoverable: number
  ready: number
}

interface Candidate {
  id: string
  title: string
  cwd: string
  updatedAt: number | string | null
  status: 'ready' | 'recoverable'
}

interface ImportResult {
  found: number
  imported: number
  existing: number
  failed: number
  failures: readonly { thread: string; message: string }[]
}

interface Progress extends ImportResult {
  completed: number
  total: number
}

interface Observable<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

export interface WorkspaceImportInjected {
  hooks: {
    workspaceImportWorkspaces: Observable<WorkspaceState>
    workspaceImportSessions: Observable<SessionState>
  }
  scanWorkspace: (cwd: string) => Promise<{
    workspace: { title: string; path: string }
    summary: Summary
    candidates: readonly Candidate[]
  }>
  importWorkspace: (
    cwd: string,
    threadIds: readonly string[],
    onProgress: (progress: Progress) => void,
  ) => Promise<ImportResult>
  refreshWorkspaceState: () => Promise<void>
}

type Props = PropsRuntime<'sidebar.footer.action'>
  & InjectFace<WorkspaceImportInjected>
  & PropsLocale<'relay.codex'>

type Phase = 'idle' | 'no-workspace' | 'select-workspace' | 'scanning' | 'summary' | 'importing' | 'complete' | 'error'

export function WorkspaceImportAction({
  wide,
  useWorkspaceImportWorkspaces,
  useWorkspaceImportSessions,
  scanWorkspace,
  importWorkspace,
  refreshWorkspaceState,
  t,
}: Props): ReactNode {
  const workspaces = useWorkspaceImportWorkspaces(value => value)
  const sessions = useWorkspaceImportSessions(value => value)
  const availableTarget = resolveImportWorkspace(workspaces, sessions) as WorkspaceView | null
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<WorkspaceView | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [candidates, setCandidates] = useState<readonly Candidate[]>([])
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [progress, setProgress] = useState<Progress | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState('')
  const request = useRef(0)

  const close = (): void => {
    if (!workspaceImportUiPolicy(phase, selectedIds.size, result?.failed).canClose) return
    request.current += 1
    setOpen(false)
  }

  const scan = (workspace: WorkspaceView): void => {
    const generation = ++request.current
    setPhase('scanning')
    setSummary(null)
    setCandidates([])
    setSelectedIds(new Set())
    setProgress(null)
    setResult(null)
    setError('')
    void scanWorkspace(workspace.path).then(
      response => {
        if (request.current !== generation) return
        setSummary(response.summary)
        setCandidates(response.candidates)
        setSelectedIds(new Set(response.candidates.map(candidate => candidate.id)))
        setPhase('summary')
      },
      reason => {
        if (request.current !== generation) return
        setError(messageOf(reason))
        setPhase('error')
      },
    )
  }

  const begin = (): void => {
    const selected = availableTarget ?? workspaces.items[0] ?? null
    setTarget(selected)
    setOpen(true)
    if (selected === null) {
      setPhase('no-workspace')
      return
    }
    setPhase('select-workspace')
  }

  const scanSelected = (): void => {
    if (target !== null) scan(target)
  }

  const importSelected = (): void => {
    const threadIds = candidates
      .filter(candidate => selectedIds.has(candidate.id))
      .map(candidate => candidate.id)
    if (target === null || summary === null || threadIds.length === 0 || phase === 'importing') return
    const generation = ++request.current
    setPhase('importing')
    setProgress({
      completed: 0,
      total: threadIds.length,
      found: threadIds.length,
      imported: 0,
      existing: 0,
      failed: 0,
      failures: [],
    })
    setError('')
    void (async () => {
      try {
        const completed = await importWorkspace(target.path, threadIds, update => {
          if (request.current === generation) setProgress(update)
        })
        await refreshWorkspaceState()
        if (request.current !== generation) return
        setResult(completed)
        setPhase('complete')
      } catch (reason) {
        if (request.current !== generation) return
        setError(messageOf(reason))
        setPhase('error')
      }
    })()
  }

  const retry = (): void => {
    if (target !== null) scan(target)
  }

  return (
    <>
      <Tooltip label={t('importAction')} side="top" delayMs={500}>
        <button
          type="button"
          className={css.trigger}
          aria-label={t('importAction')}
          data-provider="codex"
          data-compact={wide ? undefined : 'true'}
          onClick={begin}
        >
          <IconCodeOutline16 size={wide ? 18 : 16} />
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={close}
        title={t('importTitle')}
        closeLabel={t('close')}
        description={t('importDescription')}
        className={css.dialog}
        footer={modalFooter({
          phase,
          selectedCount: selectedIds.size,
          result,
          close,
          scanSelected,
          retry,
          importSelected,
          t,
        })}
      >
        <div className={css.body} aria-live="polite">
          {phase === 'select-workspace' && target !== null && (
            <div className={css.workspaceChoice}>
              <label htmlFor="codex-import-workspace">{t('importWorkspaceLabel')}</label>
              <select
                id="codex-import-workspace"
                value={target.workspaceId}
                aria-describedby="codex-import-workspace-help"
                onChange={event => {
                  const selected = workspaces.items.find(workspace => workspace.workspaceId === event.currentTarget.value)
                  if (selected !== undefined) setTarget(selected)
                }}
              >
                {workspaces.items.map(workspace => (
                  <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
                ))}
              </select>
              <span id="codex-import-workspace-help" className={css.message}>{t('importChooseWorkspace')}</span>
              <span className={css.workspacePath} title={target.path}>{target.path}</span>
            </div>
          )}
          {target !== null && phase !== 'select-workspace' && (
            <div className={css.workspace}>
              <strong>{target.title}</strong>
              <span title={target.path}>{target.path}</span>
            </div>
          )}
          {phase === 'no-workspace' && <p className={css.message}>{t('importNoWorkspace')}</p>}
          {phase === 'scanning' && <p className={css.message}>{t('importScanning')}</p>}
          {phase === 'summary' && summary !== null && (
            <SummaryView
              summary={summary}
              candidates={candidates}
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              t={t}
            />
          )}
          {phase === 'importing' && progress !== null && <ProgressView progress={progress} t={t} />}
          {phase === 'complete' && result !== null && <ResultView result={result} t={t} />}
          {phase === 'error' && <p className={css.error} role="alert">{error || t('importFailed')}</p>}
        </div>
      </Modal>
    </>
  )
}

function SummaryView({
  summary,
  candidates,
  selectedIds,
  onSelectionChange,
  t,
}: {
  summary: Summary
  candidates: readonly Candidate[]
  selectedIds: ReadonlySet<string>
  onSelectionChange: (selected: ReadonlySet<string>) => void
  t: Props['t']
}): ReactNode {
  const select = (id: string, checked: boolean): void => {
    const next = new Set(selectedIds)
    if (checked) next.add(id)
    else next.delete(id)
    onSelectionChange(next)
  }
  return (
    <div className={css.summary}>
      <dl className={css.metrics}>
        <Metric label={t('importFound')} value={summary.found} />
        <Metric label={t('importExisting')} value={summary.existing} />
        <Metric label={t('importRecoverable')} value={summary.recoverable} />
        <Metric label={t('importReady')} value={summary.ready} accent />
      </dl>
      {candidates.length === 0 ? (
        <p className={css.message}>{t('importEmpty')}</p>
      ) : (
        <>
          <div className={css.selectionToolbar}>
            <span>{t('importSelected')}: {selectedIds.size} / {candidates.length}</span>
            <div>
              <button type="button" onClick={() => onSelectionChange(new Set(candidates.map(candidate => candidate.id)))}>
                {t('importSelectAll')}
              </button>
              <button type="button" onClick={() => onSelectionChange(new Set())}>
                {t('importClearSelection')}
              </button>
            </div>
          </div>
          <ul className={css.candidates} aria-label={t('importCandidates')}>
            {candidates.map(candidate => (
              <li key={candidate.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(candidate.id)}
                    onChange={event => select(candidate.id, event.currentTarget.checked)}
                  />
                  <span className={css.candidateBody}>
                    <span className={css.candidateHeading}>
                      <strong>{candidate.title}</strong>
                      <span>{candidate.status === 'recoverable' ? t('importStatusRecoverable') : t('importStatusReady')}</span>
                    </span>
                    <code>{candidate.id}</code>
                    <span title={candidate.cwd}>{candidate.cwd}</span>
                    <time dateTime={dateTimeValue(candidate.updatedAt)}>{formatUpdatedAt(candidate.updatedAt)}</time>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function ProgressView({ progress, t }: { progress: Progress; t: Props['t'] }): ReactNode {
  const maximum = Math.max(1, progress.total)
  return (
    <div className={css.progress}>
      <div className={css.progressCopy}>
        <strong>{t('importImporting')}</strong>
        <span>{progress.completed} / {progress.total}</span>
      </div>
      <progress value={progress.completed} max={maximum} aria-label={t('importImporting')} />
    </div>
  )
}

function ResultView({ result, t }: { result: ImportResult; t: Props['t'] }): ReactNode {
  return (
    <div>
      <p className={result.failed > 0 ? css.partial : css.success}>
        {result.failed > 0 ? t('importPartial') : t('importComplete')}
      </p>
      <dl className={css.metrics}>
        <Metric label={t('importImported')} value={result.imported} accent />
        <Metric label={t('importExisting')} value={result.existing} />
        <Metric label={t('importFailures')} value={result.failed} danger={result.failed > 0} />
      </dl>
      {result.failures.length > 0 && (
        <ul className={css.failures} aria-label={t('importFailures')}>
          {result.failures.map(failure => (
            <li key={failure.thread}>
              <code>{failure.thread}</code>
              <span>{failure.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Metric({
  label, value, accent = false, danger = false,
}: { label: string; value: number; accent?: boolean; danger?: boolean }): ReactNode {
  return (
    <div className={css.metric}>
      <dt>{label}</dt>
      <dd className={danger ? css.dangerValue : accent ? css.accentValue : undefined}>{value}</dd>
    </div>
  )
}

function modalFooter({
  phase, selectedCount, result, close, scanSelected, retry, importSelected, t,
}: {
  phase: Phase
  selectedCount: number
  result: ImportResult | null
  close: () => void
  scanSelected: () => void
  retry: () => void
  importSelected: () => void
  t: Props['t']
}): ReactNode {
  const policy = workspaceImportUiPolicy(phase, selectedCount, result?.failed, phase !== 'no-workspace')
  const actions: Record<WorkspaceImportUiAction, (() => void) | undefined> = {
    cancel: close,
    close,
    'import-selected': importSelected,
    importing: undefined,
    retry,
    scan: scanSelected,
  }
  const labels: Record<WorkspaceImportUiAction, string> = {
    cancel: t('cancel'),
    close: t('close'),
    'import-selected': t('importSelectedAction'),
    importing: t('importImporting'),
    retry: t('retry'),
    scan: t('importScanAction'),
  }
  return (
    <>
      {policy.secondary !== undefined && (
        <Button variant="outline" onClick={actions[policy.secondary]}>
          {labels[policy.secondary]}
        </Button>
      )}
      <Button
        variant={policy.primary === 'close' ? 'outline' : undefined}
        disabled={policy.primaryDisabled}
        onClick={actions[policy.primary]}
      >
        {labels[policy.primary]}
      </Button>
    </>
  )
}

function dateTimeValue(value: Candidate['updatedAt']): string | undefined {
  const date = workspaceImportUpdatedAtDate(value)
  return date?.toISOString()
}

function formatUpdatedAt(value: Candidate['updatedAt']): string {
  const date = workspaceImportUpdatedAtDate(value)
  return date === null ? '-' : new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
