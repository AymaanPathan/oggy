import type { OggyApi, OggySetupApi } from '../common/api'

declare global {
  interface Window {
    oggy: OggyApi
    oggySetup: OggySetupApi
  }
}

export {}
