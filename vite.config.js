import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on 0.0.0.0 so other devices on the LAN (e.g. your phone) can connect
    // Default VITE_API_URL=/api is same-origin, so dev needs these forwarded
    // to the Nest backend (production nginx does the same thing).
    proxy: {
      '/api':      { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
})
