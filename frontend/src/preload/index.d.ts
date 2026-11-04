import type { OggyApi } from '../common/api'

declare global {
  interface Window {
    oggy: OggyApi
  }
}

export {}
