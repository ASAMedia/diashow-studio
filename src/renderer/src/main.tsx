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
import './styles.css'
import { setLocale } from './i18n'
import { App } from './App'
import { playerRef, useStore } from './store'
import { exportShow } from './engine/exporter'

// Test hook used by the Playwright end-to-end tests.
;(window as unknown as { __diashow: unknown }).__diashow = { store: useStore, player: playerRef, exportShow }

void window.api.locale().then((l) => {
  setLocale(l)
  document.documentElement.lang = l.slice(0, 2)
  createRoot(document.getElementById('root')!).render(<App />)
})
