import type { Lookups } from './engine/resolve.ts'
import type { ImageResult } from './engine/types.ts'

// Live registry lookups. PyPI and npm allow CORS; container registries go through /api/manifest.
const mem = new Map<string, Promise<unknown>>()
const KEY = 'arm-ready.cache.v1'
const TTL = 12 * 3600_000
let disk: Record<string, { at: number; v: unknown }> = {}
try { disk = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') } catch { disk = {} }
const persist = () => { try { sessionStorage.setItem(KEY, JSON.stringify(disk)) } catch { /* quota: memory cache still works */ } }

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = disk[key]
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.v as T)
  if (!mem.has(key)) mem.set(key, fn().then(v => { if (v) { disk[key] = { at: Date.now(), v }; persist() } return v }).catch(e => { mem.delete(key); throw e }))
  return mem.get(key) as Promise<T>
}

const json = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export const liveLookups: Lookups = {
  image: ref => cached(`img:${ref}`, async () => {
    try {
      const r = await json(`/api/manifest?ref=${encodeURIComponent(ref)}`) as ImageResult | null
      return r ?? { ok: false, error: 'Lookup service unavailable.' }
    } catch { return { ok: false, error: 'Could not reach the lookup service. Use the CLI export instead.' } }
  }),
  pypi: (name, version) => cached(`py:${name}@${version ?? ''}`, async () => {
    const j = await json(`https://pypi.org/pypi/${encodeURIComponent(name)}/${version ? encodeURIComponent(version) + '/' : ''}json`) as { info: { version: string }; urls: { filename: string; packagetype: string }[] } | null
    return j ? { version: j.info.version, files: j.urls.map(u => ({ filename: u.filename, packagetype: u.packagetype })) } : null
  }),
  npm: (name, version) => cached(`npm:${name}@${version ?? ''}`, async () => {
    const j = await json(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${version ?? 'latest'}`)
    return j ? { name: j.name, version: j.version, gypfile: j.gypfile, binary: j.binary, scripts: j.scripts, optionalDependencies: j.optionalDependencies, dependencies: j.dependencies } : null
  }),
}
