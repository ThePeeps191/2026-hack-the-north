/**
 * Which URLs a *remote* browser is allowed to load.
 *
 * The browser Huddle drives for Sam runs in Browserbase's cloud, on a machine
 * that is not this one. It cannot reach `http://localhost:5173`, and it cannot
 * reach anything on the local network either. Huddle says so instead of typing a
 * URL into a remote browser and reporting a confusing timeout.
 */

import { URL } from 'node:url'

export type TargetCheck =
  | { ok: true; url: string }
  | { ok: false; detail: string; fix: string }

const REFUSAL =
  'The browser Huddle drives runs in Browserbase, not on this machine, so it cannot reach a local address.'

const PREVIEW_FIX =
  'Start the preview (Browser surface → Start preview) so Huddle exposes a tunnel URL, then open the session without a URL. Settings → Preview mode must be "tunnel" for that.'

function privateReason(host: string): string | null {
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `${REFUSAL} "${host}" is this laptop.`
  }
  if (host === '0.0.0.0' || host === '::1' || host === '[::1]') {
    return `${REFUSAL} "${host}" is this laptop.`
  }
  if (/^127\./.test(host)) {
    return `${REFUSAL} "${host}" is the loopback interface of this laptop.`
  }
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return `${REFUSAL} "${host}" is a private address on this network.`
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return `${REFUSAL} "${host}" is a private address on this network.`
  }
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) {
    return `${REFUSAL} "${host}" only resolves inside this network.`
  }
  return null
}

/** Absolute http(s) URL that a cloud browser could actually open. */
export function checkRemoteTarget(input: string): TargetCheck {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      detail: 'No URL was given.',
      fix: 'Pass an absolute http(s) URL, or let Huddle use the project preview URL.'
    }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return {
      ok: false,
      detail: `"${trimmed}" is not an absolute URL.`,
      fix: 'Use a full URL including the scheme, for example https://example.com/.'
    }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      detail: `The remote browser loads http(s) pages; "${parsed.protocol}" is not one of them.`,
      fix: 'Use http:// or https://.'
    }
  }

  const host = parsed.hostname.toLowerCase()
  const reason = privateReason(host)
  if (reason !== null) {
    return { ok: false, detail: reason, fix: PREVIEW_FIX }
  }

  return { ok: true, url: parsed.toString() }
}

/** Where a dev-server preview is reachable from, in one line for a detail field. */
export function describePreviewReachability(mode: string, state: string): string {
  if (mode === 'lan') {
    return 'The preview is exposed on the local network only; a cloud browser cannot reach it.'
  }
  if (mode === 'off') {
    return 'Preview exposure is off, so no URL exists that a cloud browser could load.'
  }
  if (state === 'starting') {
    return 'The preview is still starting; there is no reachable URL yet.'
  }
  if (state === 'failed') {
    return 'The preview is not running, so there is no reachable URL.'
  }
  return 'No publicly reachable preview URL is available.'
}
