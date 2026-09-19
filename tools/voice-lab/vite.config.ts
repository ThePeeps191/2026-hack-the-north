import { defineConfig } from "vite";

const serverPort = Number(process.env.VOICE_LAB_PORT ?? 8787);

export default defineConfig({
  root: "src/client",
  publicDir: "public",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true
      },
      "/ws": {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true
      }
    }
  }
});
