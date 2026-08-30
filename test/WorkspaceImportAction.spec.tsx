// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  IconCodeOutline16: () => <svg data-testid="codex-provider-glyph" aria-hidden="true" />,
  IconDownloadOutline16: () => <svg data-testid="import-glyph" aria-hidden="true" />,
  Modal: ({ open, title, children, footer }: {
    open: boolean
    title: string
    children: React.ReactNode
    footer: React.ReactNode
  }) => open ? <div role="dialog" aria-label={title}>{children}{footer}</div> : null,
  Tooltip: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <>{children}<span role="tooltip">{label}</span></>
  ),
}))

import { WorkspaceImportAction } from '../src/client/WorkspaceImportAction.tsx'
import { en } from '../src/client/locales.ts'

const workspaces = {
  recentWorkspaceId: 'workspace-beta',
  items: [
    { workspaceId: 'workspace-alpha', title: 'Alpha', path: '/work/alpha', sessionIds: ['session-alpha'] },
    { workspaceId: 'workspace-beta', title: 'Beta', path: '/work/beta', sessionIds: [] },
  ],
}

afterEach(cleanup)

describe('WorkspaceImportAction', () => {
  it('renders an import glyph with a distinct Codex badge and an accessible Tooltip', () => {
    renderAction()

    const trigger = screen.getByRole('button', { name: en.importAction })
    expect(trigger.dataset.provider).toBe('codex')
    expect(trigger.querySelector('[data-icon-role="import-provider"]')).not.toBeNull()
    expect(trigger.querySelector('[data-provider-badge="codex"]')).not.toBeNull()
    expect(screen.getByTestId('import-glyph')).not.toBeNull()
    expect(screen.getByTestId('codex-provider-glyph')).not.toBeNull()
    expect(trigger.querySelectorAll('svg')).toHaveLength(2)
    expect(trigger.textContent).toBe('')

    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip').textContent).toBe(en.importAction)
  })

  it('marks the collapsed action for the 28-pixel rail geometry', () => {
    renderAction({ wide: false })
    expect(screen.getByRole('button', { name: en.importAction }).dataset.compact).toBe('true')
  })

  it('waits for explicit Workspace confirmation and scans the visible selection', async () => {
    const scanWorkspace = vi.fn().mockResolvedValue({
      workspace: { title: 'Beta', path: '/work/beta' },
      summary: { found: 0, existing: 0, recoverable: 0, ready: 0 },
      candidates: [],
    })
    renderAction({ scanWorkspace })

    fireEvent.click(screen.getByRole('button', { name: en.importAction }))
    expect(scanWorkspace).not.toHaveBeenCalled()

    const selector = screen.getByRole('combobox', { name: en.importWorkspaceLabel }) as HTMLSelectElement
    expect(selector.value).toBe('workspace-alpha')
    expect(screen.getByText('/work/alpha')).not.toBeNull()

    fireEvent.change(selector, { target: { value: 'workspace-beta' } })
    expect(selector.value).toBe('workspace-beta')
    expect(screen.getByText('/work/beta')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.importScanAction }))
    await waitFor(() => { expect(scanWorkspace).toHaveBeenCalledWith('/work/beta') })
    expect(scanWorkspace).toHaveBeenCalledTimes(1)
  })

  it('shows a no-Workspace state and never scans when the list is empty', () => {
    const scanWorkspace = vi.fn()
    renderAction({
      workspaceState: { items: [], recentWorkspaceId: undefined },
      sessionState: { current: undefined },
      scanWorkspace,
    })

    fireEvent.click(screen.getByRole('button', { name: en.importAction }))
    expect(screen.getByText(en.importNoWorkspace)).not.toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(scanWorkspace).not.toHaveBeenCalled()
  })
})

function renderAction({
  workspaceState = workspaces,
  sessionState = { current: 'session-alpha' },
  scanWorkspace = vi.fn(),
  wide = true,
}: {
  workspaceState?: typeof workspaces | { items: readonly never[]; recentWorkspaceId?: undefined }
  sessionState?: { current?: string }
  scanWorkspace?: ReturnType<typeof vi.fn>
  wide?: boolean
} = {}): void {
  render(<WorkspaceImportAction
    wide={wide}
    useWorkspaceImportWorkspaces={selector => selector(workspaceState as never)}
    useWorkspaceImportSessions={selector => selector(sessionState as never)}
    scanWorkspace={scanWorkspace as never}
    importWorkspace={vi.fn() as never}
    refreshWorkspaceState={vi.fn() as never}
    t={(key => en[key]) as never}
  />)
}
