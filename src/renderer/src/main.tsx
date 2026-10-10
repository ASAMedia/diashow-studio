import { createRoot } from 'react-dom/client'
import '@fontsource/inter/300.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/anton/400.css'
import '@fontsource/cinzel/400.css'
import '@fontsource/special-elite/400.css'
import '@fontsource/playfair-display/400.css'
import '@fontsource/barlow-semi-condensed/500.css'
import '@fontsource/barlow-semi-condensed/600.css'
import '@fontsource/nunito-sans/800.css'
import '@fontsource/caveat/400.css'
import '@fontsource/caveat/600.css'
import '@fontsource/caveat/700.css'
import './styles.css'
import { setLocale } from './i18n'
import { App } from './App'
import { PresentView } from './components/Presentation'
import { playerRef, useStore } from './store'
import { exportShow, queueExport, runExportWorker } from './engine/exporter'
import { detectFaces } from './faces'

// Test hook used by the Playwright end-to-end tests.
;(window as unknown as { __diashow: unknown }).__diashow = { store: useStore, player: playerRef, exportShow, queueExport, detectFaces }

// A .dshow file opened with the app (double click, or while it is running). Subscribed before
// the first render so a file passed at launch isn't missed.
const route = location.hash

if (route === '#export-worker') {
  // hidden window of the export queue: no UI, it renders until the queue is empty
  void window.api.locale().then((l) => {
    setLocale(l)
    void runExportWorker()
  })
} else if (route !== '#present') {
  window.api.onOpenFile(async (path) => {
    const p = await window.api.importProjectFile(path)
    await useStore.getState().openProjectData(p)
  })
}

if (route !== '#export-worker') {
  void window.api.locale().then((l) => {
    setLocale(l)
    document.documentElement.lang = l.slice(0, 2)
    // the presentation window loads the same page with #present
    createRoot(document.getElementById('root')!).render(route === '#present' ? <PresentView /> : <App />)
  })
}
