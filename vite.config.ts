import { defineConfig, type Connect } from 'vite'
import react from '@vitejs/plugin-react'

// Serves the /api/manifest function locally (dev and preview) so live registry checks work off Vercel too.
const api: Connect.NextHandleFunction = async (req, res, next) => {
  if (!req.url?.startsWith('/api/manifest')) return next()
  // @ts-expect-error plain JS module shared with the Vercel function
  const { GET } = await import('./api/manifest.js')
  const r: Response = await GET(new Request('http://localhost' + req.url))
  res.statusCode = r.status
  res.setHeader('content-type', 'application/json')
  res.end(await r.text())
}

export default defineConfig({
  plugins: [react(), { name: 'local-api', configureServer: s => { s.middlewares.use(api) }, configurePreviewServer: s => { s.middlewares.use(api) } }],
})
