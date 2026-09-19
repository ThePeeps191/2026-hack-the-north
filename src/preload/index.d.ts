import type { HuddleApi } from '../shared/api'

declare global {
  interface Window {
    huddle: HuddleApi
  }
}

export {}
