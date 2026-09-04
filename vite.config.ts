import { defineConfig } from 'vite'

// GitHub Pages serves from /<repo>/; local dev and other hosts use /.
const base = process.env.GH_PAGES_BASE ?? '/'

export default defineConfig({
  base,
  server: {
    host: '0.0.0.0',
    port: 43217,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 43217,
    strictPort: true,
    allowedHosts: true,
  },
})
