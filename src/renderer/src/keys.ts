// Which key presses belong to the focused element instead of the app's shortcuts (Space plays the
// preview, arrows step, X leaves out, Ctrl+V inserts copied photos, …): typing in a field (where Ctrl+V
// pastes text), and Space/Enter on a button or link the user reached with the keyboard. A button that
// was clicked with the mouse keeps the focus but not the keys, so Space still plays the show after
// clicking a button.

const TEXT = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]'
const ACTIVATE = 'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"]'

export function keyForFocus(e: KeyboardEvent): boolean {
  const el = e.target instanceof Element ? e.target : null
  if (!el) return false
  // a slider keeps its arrow keys, but has no undo of its own: Ctrl+Z / Ctrl+Y stay the app's
  if (el.matches('input[type="range"]') && e.ctrlKey && !e.altKey && /^[zy]$/i.test(e.key)) return false
  if (el.closest(TEXT)) return true
  if (e.key === ' ' || e.key === 'Enter' || e.code === 'Space') {
    const control = el.closest<HTMLElement>(ACTIVATE)
    // filmstrip cards leave Space to the app (it plays the show); they handle Enter themselves
    if (control && control.matches(':focus-visible') && !control.closest('[data-keys="app"]')) return true
  }
  return false
}

/** A dialog (assistant, repair, …) is open: the editor's shortcuts wait until it closes. */
export function modalOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}
