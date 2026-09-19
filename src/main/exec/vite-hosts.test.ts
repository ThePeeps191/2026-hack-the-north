import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ensureViteAllowsTunnelHosts } from './vite-hosts.ts'

const SKETCH_NIGHT_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5274',
        changeOrigin: true,
      },
    },
  },
});
`

describe('ensureViteAllowsTunnelHosts', () => {
  test('adds allowedHosts true to a Vite server block that lacks it', () => {
    const result = ensureViteAllowsTunnelHosts(SKETCH_NIGHT_CONFIG)
    assert.equal(result.changed, true)
    assert.match(result.text, /allowedHosts:\s*true/)
    assert.match(result.text, /host: '127\.0\.0\.1'/)
  })

  test('leaves a config that already allows tunneled hosts alone', () => {
    const already = SKETCH_NIGHT_CONFIG.replace(
      'server: {\n    host:',
      'server: {\n    allowedHosts: true,\n    host:'
    )
    const result = ensureViteAllowsTunnelHosts(already)
    assert.equal(result.changed, false)
    assert.equal(result.text, already)
  })

  test('does not invent a Vite config from unrelated source', () => {
    const result = ensureViteAllowsTunnelHosts('module.exports = { port: 3000 }')
    assert.equal(result.changed, false)
  })
})
