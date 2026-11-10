// GET /api/manifest?ref=<image>  ->  { ok, platforms: [{os, architecture, variant}], source }
// Docker Hub, GHCR, MCR, GCR and most registries do not send CORS headers, so the browser asks this
// function. Only anonymous (public) pulls are attempted; nothing is stored.

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

export function parseRef(raw) {
  let s = String(raw || '').trim()
  if (!s || s.length > 300 || !/^[\w.\-/:@]+$/.test(s)) return null
  let ref = 'latest'
  const at = s.indexOf('@')
  if (at >= 0) { ref = s.slice(at + 1); s = s.slice(0, at) }
  else {
    const slash = s.lastIndexOf('/'), colon = s.lastIndexOf(':')
    if (colon > slash) { ref = s.slice(colon + 1); s = s.slice(0, colon) }
  }
  const parts = s.split('/')
  let host = 'docker.io'
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':'))) host = parts.shift()
  // Public registries only: a hostname with a dot, no raw IPs or localhost.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host) || /^[\d.:]+$/.test(host)) return null
  let repo = parts.join('/').toLowerCase()
  if (host === 'docker.io' || host === 'index.docker.io') { host = 'docker.io'; if (!repo.includes('/')) repo = 'library/' + repo }
  return { host, repo, ref }
}

const timeout = ms => AbortSignal.timeout(ms)

async function hub(repo, tag) {
  const [ns, name] = repo.split('/')
  const r = await fetch(`https://hub.docker.com/v2/namespaces/${ns}/repositories/${name}/tags/${encodeURIComponent(tag)}`, { signal: timeout(8000) })
  if (r.status === 404) return { ok: false, status: 404, error: `Tag ${tag} not found on Docker Hub.` }
  if (!r.ok) return null
  const j = await r.json()
  const platforms = (j.images || []).filter(i => i.os && i.os !== 'unknown').map(i => ({ os: i.os, architecture: i.architecture, ...(i.variant ? { variant: i.variant } : {}) }))
  return platforms.length ? { ok: true, platforms, source: 'Docker Hub' } : null
}

async function registryFetch(host, path, accept, token) {
  const base = host === 'docker.io' ? 'registry-1.docker.io' : host
  const headers = { Accept: accept }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(`https://${base}/v2/${path}`, { headers, redirect: 'follow', signal: timeout(9000) })
}

async function anonToken(challenge) {
  const p = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
  if (!p.realm || !/^https:\/\//.test(p.realm)) return null
  const u = new URL(p.realm)
  if (p.service) u.searchParams.set('service', p.service)
  if (p.scope) u.searchParams.set('scope', p.scope)
  const r = await fetch(u, { signal: timeout(8000) })
  if (!r.ok) return null
  const j = await r.json()
  return j.token || j.access_token || null
}

async function oci(host, repo, ref) {
  let token = null
  let r = await registryFetch(host, `${repo}/manifests/${ref}`, ACCEPT)
  if (r.status === 401) {
    token = await anonToken(r.headers.get('www-authenticate') || '')
    if (!token) return { ok: false, status: 401, error: 'Registry requires credentials (private image?).' }
    r = await registryFetch(host, `${repo}/manifests/${ref}`, ACCEPT, token)
  }
  if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, error: 'Registry requires credentials (private image?).' }
  if (r.status === 404) return { ok: false, status: 404, error: `${host}/${repo}:${ref} not found.` }
  if (r.status === 429) return { ok: false, status: 429, error: 'Registry rate limit hit. Try again later or use the CLI export.' }
  if (!r.ok) return { ok: false, status: r.status, error: `Registry answered ${r.status}.` }
  const m = await r.json()
  if (Array.isArray(m.manifests)) {
    const platforms = m.manifests
      .filter(x => x.platform && x.platform.os !== 'unknown' && x.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest')
      .map(x => ({ os: x.platform.os, architecture: x.platform.architecture, ...(x.platform.variant ? { variant: x.platform.variant } : {}) }))
    return { ok: true, platforms, source: host }
  }
  // Single-platform image: the architecture lives in the config blob.
  if (m.config?.digest) {
    const c = await registryFetch(host, `${repo}/blobs/${m.config.digest}`, '*/*', token)
    if (c.ok) {
      const cfg = await c.json()
      return { ok: true, platforms: [{ os: cfg.os || 'linux', architecture: cfg.architecture || 'unknown', ...(cfg.variant ? { variant: cfg.variant } : {}) }], source: host }
    }
  }
  return { ok: false, error: 'Could not read the image platform.' }
}

export async function lookup(raw) {
  const p = parseRef(raw)
  if (!p) return { ok: false, status: 400, error: 'Not a public image reference.' }
  if (p.host === 'docker.io' && !p.ref.startsWith('sha256:')) {
    try { const h = await hub(p.repo, p.ref); if (h) return h } catch { /* fall through to the registry API */ }
  }
  try { return await oci(p.host, p.repo, p.ref) } catch (e) { return { ok: false, error: e?.name === 'TimeoutError' ? 'Registry timed out.' : 'Registry unreachable.' } }
}

export async function GET(request) {
  const ref = new URL(request.url).searchParams.get('ref')
  const out = await lookup(ref)
  const cache = out.ok ? 'public, s-maxage=21600, stale-while-revalidate=86400' : 'public, s-maxage=300'
  return Response.json(out, { status: out.status === 400 ? 400 : 200, headers: { 'Cache-Control': cache } })
}
