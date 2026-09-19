export {}

declare global {
  interface Window {
    huddle: Record<string, never>
  }
}
