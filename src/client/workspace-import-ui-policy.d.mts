export type WorkspaceImportUiAction = 'cancel' | 'close' | 'import-selected' | 'importing' | 'retry' | 'scan'

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
  hasWorkspace?: boolean,
): WorkspaceImportUiPolicy

export function workspaceImportUpdatedAtDate(value: number | string | null | undefined): Date | null
