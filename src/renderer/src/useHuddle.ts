import { useEffect, useState } from 'react'
import type { AppSnapshot, RuntimeEvent } from '../../shared/types'
import { applyRuntimeEvent } from './apply-event'

export function useHuddle(): {
  snapshot: AppSnapshot | null
  loading: boolean
  loadError: string | null
} {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let ready = false
    let lastSeq = -1
    const seen = new Set<string>()
    const buffer: RuntimeEvent[] = []

    const applyEvent = (event: RuntimeEvent): void => {
      if (seen.has(event.id) || event.seq <= lastSeq) {
        return
      }
      seen.add(event.id)
      lastSeq = event.seq
      setSnapshot((current) => (current ? applyRuntimeEvent(current, event) : current))
    }

    const unsubscribe = window.huddle.subscribe((event) => {
      if (cancelled) {
        return
      }
      if (!ready) {
        buffer.push(event)
        return
      }
      applyEvent(event)
    })

    void window.huddle
      .getSnapshot()
      .then((next) => {
        if (cancelled) {
          return
        }
        lastSeq = next.lastSeq
        for (const event of next.events) {
          seen.add(event.id)
        }
        setSnapshot(next)
        setLoading(false)
        ready = true
        for (const event of buffer) {
          applyEvent(event)
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        setLoadError(error instanceof Error ? error.message : 'Failed to load Huddle.')
        setLoading(false)
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return { snapshot, loading, loadError }
}
