import type { DiashowApi } from '../shared/api'

declare global {
  interface Window {
    api: DiashowApi
  }
}
