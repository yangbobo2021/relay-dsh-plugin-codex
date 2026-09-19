import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ChatNodeOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { AdvancedDebugPreference } from '../../advanced-debug-preference.mjs'
import { installModelSelection, type ModelSelectionContext } from '../../model-selection.mjs'
import {
  AdvancedDebugGuard,
  AdvancedDebugSection,
  HiddenSessionLogAction,
  type AdvancedDebugInjected,
} from './AdvancedDebug.tsx'
import { CodexActivityView, GroupedCodexToolActivityView } from './CodexActivityView.tsx'
import { installProcessPresentation } from './process-presentation.tsx'
import { CODEX_ACTIVITY_TOOL } from '../../codex-activity-wire.mjs'
import { codexActivityDefinition } from './codex-activity.ts'
import { en, zh, type CodexLocaleKey } from './locales.ts'
import { WorkspaceImportProvider, type WorkspaceImportInjected } from './WorkspaceImportAction.tsx'
import type { SessionImportProviderSlotDefinition } from 'relay-dsh-plugin-session-import/contracts'
import { CodexStatusBadge } from './CodexStatus.tsx'
import {
  importCodexWorkspace,
  refreshImportedWorkspace,
  scanCodexWorkspace,
} from './workspace-import-client.mjs'
import { observeSessionOpen, syncOpenedCodexSessionAndRefresh } from './session-open-sync.mjs'
import { conversationEvents, withConversationRuntime } from './compatible-runtime.ts'
import { CodexCard } from './CodexCard.tsx'
import { CODEX_SETTINGS_NAMESPACE, CodexCardController } from './codex-card-controller.ts'

type DshSlotContractAnchors =
  | ChatNodeOwnerProps
  | SettingsSectionOwnerProps
  | SidebarFooterActionOwnerProps

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'relay.session-import.provider': SessionImportProviderSlotDefinition
  }
  interface LocaleNamespaceMap {
    'relay.codex': CodexLocaleKey
  }
}

export const inject = ['slots', 'theme', 'locale', 'sessions', 'workspaces', 'connection', 'settingsScope']

export function apply(ctx: ClientContext): () => void {
  const advancedDebug = applyAdvancedDebug(ctx)
  applyWorkspaceImport(ctx)
  applySessionOpenSync(ctx)
  applyConnectionStatus(ctx)
  applyRuntimeSettings(ctx)
  return withConversationRuntime(ctx, inner => {
    applyActivityPresentation(inner)
    installProcessPresentation(inner, advancedDebug)
    return installModelSelection(inner as ModelSelectionContext, 'relay-codex', 'relay-codex', 'relay-claude')
  })
}

function applyRuntimeSettings(ctx: ClientContext): void {
  const card = new CodexCardController(ctx.settingsScope.bind({ namespace: CODEX_SETTINGS_NAMESPACE }))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: CODEX_SETTINGS_NAMESPACE,
    locale: 'relay.codex',
    inject: () => card.inject(),
  }, CodexCard))
}

function applyActivityPresentation(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: CODEX_ACTIVITY_TOOL,
  }, GroupedCodexToolActivityView))
  conversationEvents(ctx).register(codexActivityDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'relay-codex-activity',
  }, CodexActivityView))
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
    {
      getSnapshot: () => ({ sessionId: ctx.sessions.list.getSnapshot().current }),
      subscribe: listener => ctx.sessions.list.subscribe(listener),
    },
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
  ctx.slots.inject('relay.session-import.provider', () => ctx.slots.register({
    name: 'relay.session-import.provider',
    id: 'codex',
    order: 10,
    inject: injected,
    locale: 'relay.codex',
  }, WorkspaceImportProvider))
}

function applyAdvancedDebug(ctx: ClientContext): AdvancedDebugPreference {
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
  return advancedDebug
}
