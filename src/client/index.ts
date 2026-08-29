import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AdvancedDebugPreference } from '../../advanced-debug-preference.mjs'
import { installModelSelection, type ModelSelectionContext } from '../../model-selection.mjs'
import {
  AdvancedDebugGuard,
  AdvancedDebugSection,
  HiddenSessionLogAction,
  type AdvancedDebugInjected,
} from './AdvancedDebug.tsx'
import { en, zh, type CodexLocaleKey } from './locales.ts'
import { WorkspaceImportAction, type WorkspaceImportInjected } from './WorkspaceImportAction.tsx'
import { CodexStatusBadge } from './CodexStatus.tsx'
import {
  importCodexWorkspace,
  refreshImportedWorkspace,
  scanCodexWorkspace,
} from './workspace-import-client.mjs'
import { observeSessionOpen, syncOpenedCodexSessionAndRefresh } from './session-open-sync.mjs'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'relay.codex': CodexLocaleKey
  }
}

export const inject = ['slots', 'theme', 'locale', 'sessions', 'workspaces', 'connection']

export function apply(ctx: ClientContext): () => void {
  applyAdvancedDebug(ctx)
  applyWorkspaceImport(ctx)
  applySessionOpenSync(ctx)
  applyConnectionStatus(ctx)
  return installModelSelection(ctx as ModelSelectionContext, 'relay-codex', 'relay-codex', 'relay-claude')
}

function applyConnectionStatus(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'relay-codex-connection-status',
    order: -19,
    locale: 'relay.codex',
  }, CodexStatusBadge))
}

function applySessionOpenSync(ctx: ClientContext): void {
  ctx.effect(() => observeSessionOpen(
    ctx.sessions.currentProvideInfo,
    (sessionId, isLatestSelection) => syncOpenedCodexSessionAndRefresh(
      sessionId,
      () => Promise.all([
        (ctx.sessions as typeof ctx.sessions & { refresh(): Promise<void> }).refresh(),
        (ctx.workspaces as typeof ctx.workspaces & { refresh(): Promise<void> }).refresh(),
      ]),
      fetch,
      rebuiltSessionId => ctx.sessions.open(rebuiltSessionId as Parameters<typeof ctx.sessions.open>[0]),
      undefined,
      isLatestSelection,
    ),
    error => console.warn('Codex open-time history sync failed:', error),
  ), 'relay-codex: open-time history sync')
}

function applyWorkspaceImport(ctx: ClientContext): void {
  const injected = (): WorkspaceImportInjected => ({
    hooks: {
      workspaceImportWorkspaces: ctx.workspaces.list,
      workspaceImportSessions: ctx.sessions.list,
    },
    scanWorkspace: cwd => scanCodexWorkspace(cwd),
    importWorkspace: (cwd, threadIds, onProgress) => importCodexWorkspace(cwd, { threadIds, onProgress }),
    refreshWorkspaceState: () => refreshImportedWorkspace(
      ctx.sessions as typeof ctx.sessions & { refresh(): Promise<void> },
      ctx.workspaces as typeof ctx.workspaces & { refresh(): Promise<void> },
    ),
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'relay-codex-workspace-import',
    order: -10,
    inject: injected,
    locale: 'relay.codex',
  }, WorkspaceImportAction))
}

function applyAdvancedDebug(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('relay.codex', { zh, en }), 'relay-codex: dictionaries')
  const t = ctx.locale.bind('relay.codex')
  const advancedDebug = new AdvancedDebugPreference()
  const hooks: Pick<AdvancedDebugInjected, 'hooks'> = { hooks: { advancedDebug } }
  ctx.effect(() => () => { advancedDebug.dispose() }, 'relay-codex: advanced debug preference')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'relay-codex-advanced-debug', order: 90,
    label: () => t('advancedNav'), locale: 'relay.codex',
    inject: (): AdvancedDebugInjected => ({ ...hooks, setAdvancedDebug: enabled => { advancedDebug.set(enabled) } }),
  }, AdvancedDebugSection))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'relay-codex-advanced-debug-guard', order: -20,
    inject: () => hooks,
  }, AdvancedDebugGuard))
  ctx.slots.inject('conversation.session.header.utilities', () => {
    let removeShadow: (() => void) | undefined
    const reconcile = (): void => {
      if (advancedDebug.getSnapshot()) {
        removeShadow?.(); removeShadow = undefined
      } else if (removeShadow === undefined) {
        removeShadow = ctx.slots.register({
          name: 'conversation.session.header.utilities', id: 'session-log-download', priority: -100,
        }, HiddenSessionLogAction)
      }
    }
    const unsubscribe = advancedDebug.subscribe(reconcile); reconcile()
    return () => { unsubscribe(); removeShadow?.() }
  })
}
