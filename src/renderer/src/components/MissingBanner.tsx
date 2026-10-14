// The editor's banner while originals are missing (a moved folder, a new drive letter): "Search a
// folder…" finds them again (media:relink).
import { useState } from 'react'
import { FolderSearch } from 'lucide-react'
import { useStore } from '../store'
import { count, t } from '../i18n'

/** Banner while originals are missing (moved or renamed folders). */
export function MissingBanner() {
  const project = useStore((s) => s.project)!
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const missing = project.media.filter((m) => m.status === 'error' && m.error === 'missing')
  if (!missing.length) return null
  return (
    <div className="banner" role="status">
      <FolderSearch size={16} aria-hidden />
      <span>
        {count('missingFiles', missing.length)} {result}
      </span>
      <button
        className="btn small"
        disabled={busy}
        onClick={async () => {
          const [folder] = await window.api.pickFolder()
          if (!folder) return
          setBusy(true)
          try {
            const found = await window.api.relinkMedia(missing, folder)
            const n = Object.keys(found).length
            setResult(t('relinked').replace('{n}', String(n)))
            if (n) {
              useStore.getState().update((p) => {
                for (const e of p.entries) if (e.type !== 'text' && found[e.mediaId]) e.mediaId = found[e.mediaId].id
                p.media = p.media.map((m) => found[m.id] ?? m)
              })
            }
          } finally {
            setBusy(false)
          }
        }}
      >
        {t('relink')}
      </button>
    </div>
  )
}
