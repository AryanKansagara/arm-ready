import { classifyImage, classifyNpm, classifyPypi, type NpmDoc } from './classify.ts'
import type { Finding, ImageResult, Platform, PypiFile } from './types.ts'

export interface Lookups {
  image(ref: string): Promise<ImageResult>
  pypi(name: string, version?: string): Promise<{ files: PypiFile[]; version: string } | null>
  npm(name: string, version?: string): Promise<NpmDoc | null>
}

/**
 * Resolves every pending finding with live lookups. Calls onUpdate after each one so the UI can flip tiles as they land.
 * Lookups are de-duplicated: the same image or package used by several services is fetched once.
 */
export async function resolveFindings(findings: Finding[], lk: Lookups, opts: { overrides?: Record<string, Platform[]>; concurrency?: number; onUpdate?: (f: Finding, done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<Finding[]> {
  const out = findings.map(f => ({ ...f }))
  const todo = out.filter(f => f.status === 'pending' && f.lookup)
  const memo = new Map<string, Promise<unknown>>()
  const once = <T,>(key: string, fn: () => Promise<T>) => (memo.get(key) ?? memo.set(key, fn().catch(() => null)).get(key)) as Promise<T | null>
  let done = 0, i = 0
  const work = async () => {
    while (i < todo.length) {
      if (opts.signal?.aborted) return
      const f = todo[i++]
      let v: Partial<Finding>
      try {
        if (f.lookup === 'image') {
          const ov = opts.overrides?.[f.name]
          const r = ov ? { ok: true, platforms: ov, source: 'imported manifest' } : await once(`img:${f.name}`, () => lk.image(f.name))
          v = classifyImage(r ?? { ok: false, error: 'Lookup failed.' }, f.role)
        } else if (f.lookup === 'pypi') {
          const r = await once(`py:${f.name}@${f.version ?? ''}`, () => lk.pypi(f.name, f.version))
          v = r ? { ...classifyPypi(r.files, f.libc), version: f.version ?? r.version } : { status: 'unknown', title: 'Not found on PyPI', detail: 'The package or version was not found, or PyPI was unreachable.', fix: 'Check the name and pin, or verify with pip download --platform manylinux2014_aarch64 --only-binary=:all:.', effort: 'S' }
        } else {
          const r = await once(`npm:${f.name}@${f.version ?? ''}`, () => lk.npm(f.name, f.version))
          v = r ? classifyNpm(f.name, r) : { status: 'unknown', title: 'Not found on npm', detail: 'The registry did not return this version.', effort: 'S' }
        }
      } catch {
        v = { status: 'unknown', title: 'Lookup failed', detail: 'Network error.', effort: 'S' }
      }
      Object.assign(f, v)
      delete f.lookup
      done++
      opts.onUpdate?.(f, done, todo.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, todo.length) }, work))
  return out
}
