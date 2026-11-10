import { NPM } from './knowledge.ts'
import type { Finding, ImageResult, Platform, PypiFile, ServiceScore } from './types.ts'

type Verdict = Pick<Finding, 'status' | 'title' | 'detail' | 'fix' | 'effort' | 'source'>

// ---------- Container images ----------

export const hasArm64 = (ps: Platform[]) => ps.some(p => p.os === 'linux' && (p.architecture === 'arm64' || p.architecture === 'aarch64'))

export function classifyImage(r: ImageResult, role: 'runtime' | 'build' = 'runtime'): Verdict {
  if (!r.ok || !r.platforms) return { status: 'unknown', title: 'Registry lookup failed', detail: r.error ?? 'The registry did not answer.', fix: 'Run the CLI export (Actions tab) on a machine with registry access and import the result.', effort: 'S', source: r.source }
  const ps = r.platforms.filter(p => p.os !== 'unknown')
  const list = ps.map(p => p.architecture + (p.variant ? '/' + p.variant : '')).join(', ')
  if (hasArm64(ps)) return { status: 'ok', title: ps.length > 1 ? `Multi-arch: ${ps.length} platforms incl. arm64` : 'Published for linux/arm64', detail: `Platforms: ${list}.`, effort: 'S', source: r.source }
  if (ps.some(p => p.architecture === 'arm'))
    return { status: role === 'build' ? 'warn' : 'block', title: 'Only 32-bit arm, no arm64', detail: `Platforms: ${list}. 32-bit arm/v7 images cannot run on Graviton3 and later, which have no 32-bit (AArch32) execution.`, fix: 'Ask the vendor for linux/arm64, or rebuild from source.', effort: 'M', source: r.source }
  return role === 'build'
    ? { status: 'warn', title: 'Build stage image is amd64 only', detail: `Platforms: ${list}. Fine if you cross-compile on x86 runners with --platform=$BUILDPLATFORM; blocks native arm64 builds.`, fix: 'Use FROM --platform=$BUILDPLATFORM for this stage, or pick a multi-arch builder image.', effort: 'S', source: r.source }
    : { status: 'block', title: 'No linux/arm64 image', detail: `Platforms: ${list || 'none reported'}. On Arm nodes this pod fails with "exec format error" or never schedules.`, fix: 'Ask the vendor for a multi-arch tag, build it yourself with buildx, or keep this workload on an x86 node pool.', effort: 'L', source: r.source }
}

/** Platforms from a registry manifest list / OCI index, or from `docker manifest inspect -v` output. */
export function platformsFromManifest(j: unknown): Platform[] | null {
  if (!j || typeof j !== 'object') return null
  const arr = Array.isArray(j) ? j : [j]
  const out: Platform[] = []
  for (const x of arr as Record<string, unknown>[]) {
    const manifests = x.manifests as { platform?: Platform; annotations?: Record<string, string> }[] | undefined
    if (Array.isArray(manifests)) {
      for (const m of manifests) {
        if (!m.platform || m.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest') continue
        out.push(m.platform)
      }
      continue
    }
    const d = (x.Descriptor ?? x.descriptor) as { platform?: Platform } | undefined
    if (d?.platform) { out.push(d.platform); continue }
    if (typeof x.architecture === 'string') out.push({ os: String(x.os ?? 'linux'), architecture: x.architecture, variant: x.variant as string | undefined })
  }
  return out.length ? out.map(p => ({ os: p.os, architecture: p.architecture, ...(p.variant ? { variant: p.variant } : {}) })).filter(p => p.os !== 'unknown') : null
}

/** Parses the JSONL written by the CLI export script ({"ref": "...", "manifest": {...}} per line), or a JSON array of the same. */
export function parseManifestExport(text: string): { ref: string; platforms: Platform[] | null; line: number }[] {
  const t = text.trim()
  let rows: { v: { ref?: string; image?: string; manifest?: unknown }; line: number }[] = []
  if (t.startsWith('[')) {
    try { rows = (JSON.parse(t) as object[]).map((v, i) => ({ v, line: i + 1 })) } catch { rows = [] }
  } else {
    t.split(/\r?\n/).forEach((l, i) => { if (!l.trim()) return; try { rows.push({ v: JSON.parse(l), line: i + 1 }) } catch { rows.push({ v: {}, line: i + 1 }) } })
  }
  return rows.map(({ v, line }) => ({ ref: String(v.ref ?? v.image ?? ''), platforms: platformsFromManifest(v.manifest), line }))
}

// ---------- PyPI ----------

/** Platform tags of a wheel filename (dotted compressed tags expanded). */
export function wheelPlatforms(filename: string): string[] {
  const m = filename.replace(/\.whl$/, '').split('-')
  return m.length >= 5 ? m[m.length - 1].split('.') : []
}

export function classifyPypi(files: PypiFile[], libc: 'glibc' | 'musl' = 'glibc'): Verdict {
  const wheels = files.filter(f => f.filename.endsWith('.whl'))
  const plats = wheels.flatMap(w => wheelPlatforms(w.filename))
  const sdist = files.some(f => f.packagetype === 'sdist')
  if (plats.includes('any')) return { status: 'ok', title: 'Pure-Python wheel', detail: 'Architecture-neutral.', effort: 'S', source: 'PyPI' }
  const arm = plats.filter(p => p.endsWith('aarch64') && p.includes('linux'))
  const glibc = arm.filter(p => p.startsWith('manylinux') || p.startsWith('linux_'))
  const musl = arm.filter(p => p.startsWith('musllinux'))
  if (libc === 'musl' ? musl.length : glibc.length) return { status: 'ok', title: `${libc === 'musl' ? 'musllinux' : 'manylinux'} aarch64 wheel`, detail: `Prebuilt for arm64 (${(libc === 'musl' ? musl : glibc)[0]}).`, effort: 'S', source: 'PyPI' }
  if (libc === 'musl' && glibc.length) return { status: 'warn', title: 'arm64 wheels are glibc only', detail: 'Alpine (musl) cannot use manylinux wheels, so pip compiles from source.', fix: 'Use a Debian slim base image, or add build-base and the library headers to the Alpine build stage.', effort: 'S', source: 'PyPI' }
  if (sdist) return { status: 'warn', title: 'No arm64 wheel: compiles from source', detail: wheels.length ? `Wheels exist only for ${[...new Set(plats.map(p => p.replace(/^.*_/, '')))].join(', ')}. pip will build the sdist, which needs a compiler and headers and slows builds.` : 'Only a source distribution is published, so pip builds it during docker build.', fix: 'Install gcc and the -dev headers in a builder stage, build wheels there, and copy them into the runtime stage. Or upgrade to a release with aarch64 wheels.', effort: 'M', source: 'PyPI' }
  return { status: 'block', title: 'No arm64 wheel and no source', detail: `Only ${[...new Set(plats)].join(', ') || 'no'} wheels are published; pip cannot install it on arm64.`, fix: 'Upgrade to a release with aarch64 wheels, or replace the package.', effort: 'L', source: 'PyPI' }
}

// ---------- npm ----------

export interface NpmDoc { name?: string; version?: string; gypfile?: boolean; binary?: unknown; scripts?: Record<string, string>; optionalDependencies?: Record<string, string>; dependencies?: Record<string, string> }

export function classifyNpm(name: string, doc: NpmDoc): Verdict {
  const known = NPM[name]
  if (known) return { status: known.status, title: known.title, detail: known.detail, fix: known.fix, effort: known.effort ?? 'S', source: 'curated' }
  const opt = Object.keys(doc.optionalDependencies ?? {})
  const armPkg = opt.find(d => /linux[-_]arm64|linux-arm64-gnu|linuxmusl-arm64/.test(d))
  if (armPkg) return { status: 'ok', title: 'Ships a prebuilt linux-arm64 package', detail: `npm installs ${armPkg} on arm64.`, effort: 'S', source: 'npm' }
  const install = [doc.scripts?.preinstall, doc.scripts?.install, doc.scripts?.postinstall].filter(Boolean).join(' && ')
  const deps = Object.keys(doc.dependencies ?? {})
  if (doc.binary || /node-pre-gyp|prebuild-install|node-gyp-build/.test(install) || deps.some(d => /node-pre-gyp|prebuild-install|node-gyp-build/.test(d)))
    return { status: 'warn', title: 'Native addon with downloadable prebuilds', detail: `Install runs "${install || 'a prebuild loader'}". If no linux-arm64 prebuild exists for this version it falls back to compiling with node-gyp.`, fix: 'Keep python3, make and g++ in the build stage, and run npm ci on arm64 (native runner) rather than copying node_modules from x86.', effort: 'S', source: 'npm' }
  if (doc.gypfile || /node-gyp|binding\.gyp|cmake-js/.test(install))
    return { status: 'warn', title: 'Compiles a native addon with node-gyp', detail: 'There is no prebuilt binary; npm compiles C/C++ during install.', fix: 'Install python3, make and g++ in the build stage and run npm ci for arm64 (never copy node_modules across architectures).', effort: 'S', source: 'npm' }
  return { status: 'ok', title: 'Install script is not a native build', detail: install ? `Runs "${install.slice(0, 80)}".` : 'No native code.', effort: 'S', source: 'npm' }
}

// ---------- Scoring ----------

export function scoreServices(services: string[], findings: Finding[]): ServiceScore[] {
  return services.map(name => {
    const fs = findings.filter(f => f.service === name)
    const n = (s: Finding['status']) => fs.filter(f => f.status === s).length
    const blockers = n('block'), warnings = n('warn'), unknown = n('unknown'), pending = n('pending'), ok = n('ok')
    const score = Math.max(0, Math.round(100 - Math.min(75, blockers * 25) - Math.min(30, warnings * 6) - Math.min(15, unknown * 4)))
    const state = pending ? 'scanning' : blockers ? 'blocked' : warnings || unknown ? 'needs-work' : 'ready'
    return { name, score, state, blockers, warnings, unknown, pending, ok }
  })
}

export function repoScore(scores: ServiceScore[]): number {
  return scores.length ? Math.round(scores.reduce((s, x) => s + x.score, 0) / scores.length) : 0
}
