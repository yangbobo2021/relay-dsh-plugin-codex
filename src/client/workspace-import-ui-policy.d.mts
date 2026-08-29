export type WorkspaceImportUiAction = 'cancel' | 'close' | 'import-selected' | 'importing' | 'retry'

export interface WorkspaceImportUiPolicy {
  readonly canClose: boolean
  readonly secondary?: WorkspaceImportUiAction
  readonly primary: WorkspaceImportUiAction
  readonly primaryDisabled: boolean
}

export function workspaceImportUiPolicy(
  phase: string,
  selected?: number,
  failed?: number,
): WorkspaceImportUiPolicy

export function workspaceImportUpdatedAtDate(value: number | string | null | undefined): Date | null
