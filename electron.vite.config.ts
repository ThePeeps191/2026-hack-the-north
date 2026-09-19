import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `index` is the Electron main process. `voice-helper` is a second
        // standalone bundle launched under system Node so that native audio
        // inference never has to match Electron's ABI.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'voice-helper': resolve(__dirname, 'src/main/voice-helper.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
