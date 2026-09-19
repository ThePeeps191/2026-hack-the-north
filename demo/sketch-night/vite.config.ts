import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    // localtunnel rewrites Host to the public hostname; Vite 6+ would otherwise
    // serve a "Blocked request" page instead of the app.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5274',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://127.0.0.1:5274',
        ws: true,
      },
    },
  },
});
