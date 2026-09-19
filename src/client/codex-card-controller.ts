import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

export const CODEX_SETTINGS_NAMESPACE = 'relay-codex'

export interface CodexSettings {
  codexCommand?: string
}

export type CodexRuntimeMode = 'auto' | 'bundled' | 'path'

export interface CodexCardState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  mode: CodexRuntimeMode
  path: string
  overridden: boolean
}

export interface CodexCardFace {
  hooks: { codexCard: SnapshotStore<CodexCardState> }
  setMode: (mode: CodexRuntimeMode) => void
  editPath: (value: string) => void
  reset: () => void
  save: () => void
  discard: () => void
}

export class CodexCardController {
  private draft: string | undefined
  private draftMode: CodexRuntimeMode | undefined
  private resetDraft = false
  private saving = false
  private failed = false
  private readonly store: SnapshotStore<CodexCardState>

  constructor(private readonly scope: SettingsScope<CodexSettings>) {
    scope.subscribe(() => this.publish())
    this.store = createSnapshotStore(this.project())
  }

  private snapshot(): CodexCardState {
    const host = this.scope.getSnapshot()
    const command = this.draft !== undefined
      ? this.draft
      : typeof host.value?.codexCommand === 'string' ? host.value.codexCommand : ''
    const mode = this.draftMode ?? modeOf(command)
    const user = host.user && typeof host.user === 'object' ? host.user : null
    return {
      available: host.status === 'ready',
      writable: host.writable,
      dirty: this.draftMode !== undefined || this.draft !== undefined || this.resetDraft,
      invalid: mode === 'path' && command.trim() === '',
      saving: this.saving,
      failed: this.failed,
      mode,
      path: mode === 'path' ? command : '',
      overridden: Boolean(user && Object.prototype.hasOwnProperty.call(user, 'codexCommand')),
    }
  }

  private project(): CodexCardState {
    return this.snapshot()
  }

  private publish(): void {
    this.store?.set(this.project())
  }

  setMode(mode: CodexRuntimeMode): void {
    const current = this.snapshot()
    this.failed = false
    this.resetDraft = false
    this.draftMode = mode
    this.draft = mode === 'auto' ? 'auto' : mode === 'bundled' ? 'bundled' : current.path
    this.publish()
  }

  editPath(value: string): void {
    this.failed = false
    this.resetDraft = false
    this.draftMode = 'path'
    this.draft = value
    this.publish()
  }

  reset(): void {
    this.failed = false
    this.draft = undefined
    this.draftMode = undefined
    this.resetDraft = true
    this.publish()
  }

  discard(): void {
    this.failed = false
    this.draft = undefined
    this.draftMode = undefined
    this.resetDraft = false
    this.publish()
  }

  save(): void {
    if (this.saving || this.snapshot().invalid || !this.snapshot().dirty) return
    this.saving = true
    this.failed = false
    this.publish()
    void (async () => {
      try {
        if (this.resetDraft) await this.scope.unset('codexCommand')
        else await this.scope.set('codexCommand', this.draft ?? '')
        this.draft = undefined
        this.draftMode = undefined
        this.resetDraft = false
      } catch {
        this.failed = true
      } finally {
        this.saving = false
        this.publish()
      }
    })()
  }

  inject(): CodexCardFace {
    return {
      hooks: { codexCard: this.store },
      setMode: mode => this.setMode(mode),
      editPath: value => this.editPath(value),
      reset: () => this.reset(),
      save: () => this.save(),
      discard: () => this.discard(),
    }
  }
}

function modeOf(command: string): CodexRuntimeMode {
  if (command === '' || command.toLowerCase() === 'auto') return 'auto'
  if (command.toLowerCase() === 'bundled') return 'bundled'
  return 'path'
}
