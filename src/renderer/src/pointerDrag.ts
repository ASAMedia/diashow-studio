// Pointer drags (trim handles, framing, the free collage, text boxes, crop handles, a card's time…):
// the element that got the pointerdown captures the pointer and follows it until the drag is over.
// Over is not only the button going up there. The drag can be taken away: a touch the browser takes
// for scrolling or a native drag starting (pointercancel), a lost capture, or a move with no button
// pressed, when the button went up where the window couldn't see it (after Alt+Tab or a menu of
// another window, say). Without those, the element kept following the mouse with no button pressed.
import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * Follows the pointer of `e` (a pointerdown) on its element: `move` for each move with a button
 * pressed, then `end` once. `kept` is true when the button went up (`at`: where; for a release the
 * window didn't see, the last move) and false when the drag was taken away.
 */
export function followPointer(e: ReactPointerEvent,move: (ev: PointerEvent) => void, end?: (kept: boolean, at: PointerEvent) => void): void {
  const el = e.currentTarget as Element
  const id = e.pointerId
  el.setPointerCapture(id)
  const ac = new AbortController()
  let last = e.nativeEvent
  const done = (kept: boolean, at: PointerEvent): void => {
    ac.abort()
    if (el.hasPointerCapture(id)) el.releasePointerCapture(id)
    end?.(kept, at)
  }
  const on = (type: string, fn: (ev: PointerEvent) => void): void =>
    el.addEventListener(type, (ev) => (ev as PointerEvent).pointerId === id && fn(ev as PointerEvent), { signal: ac.signal })
  on('pointermove', (ev) => {
    if (!ev.buttons) return done(true, last)
    last = ev
    move(ev)
  })
  on('pointerup', (ev) => done(true, ev))
  on('pointercancel', (ev) => done(false, ev))
  on('lostpointercapture', (ev) => done(false, ev))
}
