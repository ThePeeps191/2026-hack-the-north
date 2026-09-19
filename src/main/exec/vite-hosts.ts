import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'] as const

export interface ViteHostPatch {
  text: string
  changed: boolean
}

/**
 * Vite 6+ rejects unknown Host headers, which is what localtunnel sends.
 * Insert `allowedHosts: true` into an existing server block so a remote
 * browser can reach the real app instead of Vite's blocked-host page.
 */
export function ensureViteAllowsTunnelHosts(source: string): ViteHostPatch {
  if (/allowedHosts\s*:/.test(source)) return { text: source, changed: false }
  if (!/\bdefineConfig\s*\(/.test(source) && !/\bserver\s*:/.test(source)) {
    return { text: source, changed: false }
  }
  const withServer = source.replace(/server\s*:\s*\{/, (match) => `${match}\n    allowedHosts: true,`)
  if (withServer !== source) return { text: withServer, changed: true }
  return { text: source, changed: false }
}

/** Patch the workspace Vite config on disk. Returns true when a file was written. */
export async function ensureWorkspaceViteAllowsTunnelHosts(rootPath: string): Promise<boolean> {
  for (const name of CONFIG_NAMES) {
    const path = join(rootPath, name)
    if (!existsSync(path)) continue
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch {
      return false
    }
    const patched = ensureViteAllowsTunnelHosts(source)
    if (!patched.changed) return false
    await writeFile(path, patched.text, 'utf8')
    return true
  }
  return false
}
