// The keyboard shortcuts and mouse tips (Settings and the "⋯" menu; the handbook has them too).
import { useStore } from '../store'
import { t, type StringKey } from '../i18n'
import { Modal } from './Modal'

/** Keys of the shortcut list, written the way the keyboard labels them in the UI language. */
const SHORTCUTS: [StringKey[], StringKey][] = [
  [['kbdSpace'], 'scPlay'],
  [['kbdLeftRight'], 'scStep'],
  [['kbdAltArrows'], 'scMove'],
  [['kbdUndo', 'kbdRedo'], 'scUndo'],
  [['kbdDelete'], 'scDelete'],
  [['kbdCtrlClick'], 'scMulti'],
  [['kbdShiftClick'], 'scRange'],
  [['kbdSelectAll'], 'scAll'],
  [['kbdRotate'], 'scRotate'],
  [['kbdFind'], 'scFind'],
  [['kbdFindNext'], 'scFindNext'],
  [['kbdPaste'], 'scPaste'],
  [['kbdCtrlWheel'], 'scStripZoom'],
  [['kbdAltEnter'], 'scFullscreen'],
  [['kbdEsc'], 'scEsc'],
  [['kbdF1'], 'scHelp'],
  [['kbdTab'], 'scTab'],
  [['kbdEnter'], 'scEnter'],
  [['kbdMenu'], 'scMenu']
]

export function HelpDialog() {
  const set = useStore((s) => s.set)
  const close = (): void => set({ dialog: null })
  return (
    <Modal
      title={t('shortcuts')}
      onClose={close}
      backdropClose
      className="help-dialog"
      actions={
        <button className="btn primary" onClick={close}>
          {t('close')}
        </button>
      }
    >
      <dl className="info wide shortcuts">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt>
              {keys.map((k, i) => (
                <span key={k}>
                  {i > 0 && ' / '}
                  <kbd>{t(k)}</kbd>
                </span>
              ))}
            </dt>
            <dd>{t(label)}</dd>
          </div>
        ))}
      </dl>
      <h3 className="subhead">{t('mouseTitle')}</h3>
      <ul className="hint tips">
        <li>{t('tipDrag')}</li>
        <li>{t('tipMerge')}</li>
        <li>{t('tipCrop')}</li>
        <li>{t('tipDuration')}</li>
      </ul>
      <h3 className="subhead">{t('cull')}</h3>
      <p className="hint">{t('cullHint')}</p>
    </Modal>
  )
}
