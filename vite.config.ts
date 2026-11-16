import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineConfig, type Connect } from 'vite'
import react from '@vitejs/plugin-react'

// Serves the /api functions locally (dev and preview) so live registry and price lookups work off Vercel too.
const api: Connect.NextHandleFunction = async (req, res, next) => {
  const name = req.url?.match(/^\/api\/(manifest|prices)\b/)?.[1]
  if (!name) return next()
  // Resolved from the project root: the bundled config runs from a temp directory.
  const { GET } = await import(pathToFileURL(resolve('api', `${name}.js`)).href)
  const r: Response = await GET(new Request('http://localhost' + req.url))
  res.statusCode = r.status
  res.setHeader('content-type', 'application/json')
  res.end(await r.text())
}

export default defineConfig({
  plugins: [react(), { name: 'local-api', configureServer: s => { s.middlewares.use(api) }, configurePreviewServer: s => { s.middlewares.use(api) } }],
})
