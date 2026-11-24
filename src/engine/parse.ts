import { CARGO, GO, JAVA, NPM, OS_PACKAGES } from './knowledge.ts'
import type { Analysis, Ecosystem, FileIssue, FileKind, FileReport, Finding, RepoFile, Service } from './types.ts'

// ---------- Format detection ----------

export function detectKind(path: string, text: string): FileKind {
  const base = path.split('/').pop()!.toLowerCase()
  if (/^(dockerfile|containerfile)(\..+)?$/.test(base) || base.endsWith('.dockerfile')) return 'dockerfile'
  if (/^(docker-)?compose[\w.-]*\.ya?ml$/.test(base)) return 'compose'
  if (base === 'poetry.lock') return 'poetry'
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return 'package-lock'
  if (base === 'yarn.lock') return 'yarn-lock'
  if (base === 'pnpm-lock.yaml') return 'pnpm-lock'
  if (base === 'go.mod') return 'go-mod'
  if (base === 'pom.xml') return 'pom'
  if (base === 'cargo.lock') return 'cargo'
  if (/^build\.gradle(\.kts)?$/.test(base) || /gradle.*\.txt$/.test(base)) return 'gradle'
  if (/requirements.*\.(txt|in)$/.test(base)) return 'requirements'
  if (base.endsWith('.csv') && /instance[_ ]?type/i.test(text.split('\n')[0] ?? '')) return 'inventory'
  if (/\.(jsonl|json)$/.test(base) && /"(ref|manifest|Descriptor)"/.test(text.slice(0, 4000))) return 'manifests'
  if (/\.ya?ml$/.test(base)) {
    if (/^services:\s*$/m.test(text)) return 'compose'
    if (/^apiVersion:/m.test(text) && /^kind:/m.test(text)) return 'k8s'
  }
  // Pasted text without a useful name.
  const t = text.trimStart()
  if (/^(#.*\n|\s*\n|ARG .*\n)*FROM\s+\S+/i.test(t)) return 'dockerfile'
  if (/^apiVersion:/m.test(t) && /^kind:/m.test(t)) return 'k8s'
  if (/^services:\s*$/m.test(t)) return 'compose'
  if (/^module\s+\S+/m.test(t) && /^go\s+\d/m.test(t)) return 'go-mod'
  if (t.startsWith('<?xml') || t.startsWith('<project')) return 'pom'
  if (/^\[\[package\]\]/m.test(t) && /^checksum = /m.test(t)) return 'cargo'
  if (/^\[\[package\]\]/m.test(t)) return 'poetry'
  if (t.startsWith('{') && /"lockfileVersion"/.test(t.slice(0, 500))) return 'package-lock'
  if (/^# yarn lockfile v\d+/m.test(t) || (/^__metadata:/m.test(t) && /^\s+cacheKey:/m.test(t))) return 'yarn-lock'
  if (/^["']?lockfileVersion["']?:\s*["']?\d+\.\d+/m.test(t) && /^(importers|packages|snapshots):/m.test(t)) return 'pnpm-lock'
  if (/^[A-Za-z0-9_.-]+\s*(==|>=|~=)/m.test(t)) return 'requirements'
  return 'unknown'
}

export const KIND_LABEL: Record<FileKind, string> = {
  dockerfile: 'Dockerfile', compose: 'Docker Compose', k8s: 'Kubernetes manifest', requirements: 'requirements.txt', poetry: 'poetry.lock',
  'package-lock': 'package-lock.json', 'yarn-lock': 'yarn.lock', 'pnpm-lock': 'pnpm-lock.yaml', 'go-mod': 'go.mod', pom: 'pom.xml', gradle: 'Gradle dependencies', cargo: 'Cargo.lock',
  inventory: 'Instance inventory', manifests: 'docker manifest inspect export', unknown: 'Not recognised',
}

// ---------- Image references ----------

/** canonical is the stable key (digest wins over tag); name keeps both, the way the file wrote it. */
export interface ImageRef { registry: string; repo: string; tag: string; digest?: string; canonical: string; name: string }

export function parseImageRef(raw: string): ImageRef | null {
  let s = raw.trim().replace(/^["']|["']$/g, '')
  if (!s || /\$/.test(s) || /\s/.test(s)) return null
  let digest: string | undefined
  const at = s.indexOf('@')
  if (at >= 0) { digest = s.slice(at + 1); s = s.slice(0, at) }
  let tag = 'latest', tagged = false
  const slash = s.lastIndexOf('/')
  const colon = s.lastIndexOf(':')
  if (colon > slash) { tag = s.slice(colon + 1); s = s.slice(0, colon); tagged = true }
  const parts = s.split('/')
  let registry = 'docker.io'
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) registry = parts.shift()!
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io'
  let repo = parts.join('/').toLowerCase()
  if (!repo || !/^[a-z0-9._/-]+$/.test(repo)) return null
  if (registry === 'docker.io' && !repo.includes('/')) repo = 'library/' + repo
  const short = registry === 'docker.io' ? repo.replace(/^library\//, '') : `${registry}/${repo}`
  return { registry, repo, tag, digest, canonical: `${short}${digest ? '@' + digest : ':' + tag}`, name: `${short}${digest ? (tagged ? ':' + tag : '') + '@' + digest : ':' + tag}` }
}

// ---------- Shared helpers ----------

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length

interface Ctx { file: string; service: string; out: Finding[] }

function add(c: Ctx, f: Omit<Finding, 'id' | 'service' | 'file'> & { key?: string }) {
  const id = `${c.service}|${f.ecosystem}|${f.key ?? f.name}`
  if (c.out.some(x => x.id === id)) return
  const { key: _k, ...rest } = f
  c.out.push({ id, service: c.service, file: c.file, ...rest })
}

function imageFinding(c: Ctx, raw: string, line: number, role: 'runtime' | 'build', libc?: 'glibc' | 'musl') {
  const ref = parseImageRef(raw)
  if (!ref) {
    add(c, { ecosystem: 'image', name: raw, line, status: 'unknown', title: 'Image reference could not be resolved', detail: 'The tag is built from a variable or is malformed, so it cannot be looked up.', fix: 'Set a default for the ARG, or check this image by hand with docker manifest inspect.', effort: 'S' })
    return
  }
  // The same image used by a build stage and the final stage counts as runtime.
  const prev = c.out.find(f => f.id === `${c.service}|image|${ref.canonical}`)
  if (prev && role === 'runtime') { prev.role = 'runtime'; prev.line = line; prev.detail = ''; return }
  add(c, { ecosystem: 'image', name: ref.name, key: ref.canonical, line, status: 'pending', lookup: 'image', role, libc, title: 'Checking registry for linux/arm64', detail: '', effort: 'S' })
}

// ---------- Dockerfile ----------

/** root is the registry image a stage is ultimately built on (FROM base AS x chains resolved). */
export interface DockerStage { image: string; alias?: string; platform?: string; line: number; internal: boolean; root: string; rootLine: number; rootPlatform?: string }
export interface DockerfileInfo { stages: DockerStage[]; libc: 'glibc' | 'musl'; language?: string }

/** Joins backslash continuations, drops comments, keeps the first line number of each instruction. */
export function instructions(text: string): { line: number; op: string; args: string }[] {
  const lines = text.split(/\r?\n/)
  const out: { line: number; op: string; args: string }[] = []
  let buf = '', start = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!buf && /^\s*#/.test(l)) continue
    if (buf && /^\s*#/.test(l)) continue
    if (!buf) start = i + 1
    if (/\\\s*$/.test(l)) { buf += l.replace(/\\\s*$/, ' '); continue }
    buf += l
    const m = buf.trim().match(/^(\w+)\s*(.*)$/s)
    if (m) out.push({ line: start, op: m[1].toUpperCase(), args: m[2].trim() })
    buf = ''
  }
  if (buf.trim()) { const m = buf.trim().match(/^(\w+)\s*(.*)$/s); if (m) out.push({ line: start, op: m[1].toUpperCase(), args: m[2].trim() }) }
  return out
}

/** Set per platform by BuildKit, so a default written in the Dockerfile says nothing about the target. */
const PLATFORM_ARG = /^(BUILD|TARGET)(PLATFORM|OS|ARCH|VARIANT)$/

export function substitute(s: string, vars: Record<string, string>): string {
  return s.replace(/\$\{(\w+)(?::?[-=]([^}]*))?\}|\$(\w+)/g, (all, a, def, b) => {
    const k = a ?? b
    if (PLATFORM_ARG.test(k)) return '$' + k
    if (k in vars && vars[k] !== '') return vars[k]
    if (def !== undefined) return def
    return all
  })
}

const ARCH_VAR = /\$\{?(TARGETARCH|TARGETPLATFORM|ARCH|arch|TARGETVARIANT|dpkgArch|ARCHITECTURE)\}?|\$\(\s*(uname -m|dpkg --print-architecture|arch|apk --print-arch)\s*\)/
const X86_TOKEN = /(amd64|x86_64|x86-64|x64|linux64|linux-64|win64|i386|i686)/i

export function parseDockerfile(c: Ctx, text: string): DockerfileInfo & { issues: FileIssue[] } {
  const issues: FileIssue[] = []
  const vars: Record<string, string> = {}
  const stages: DockerStage[] = []
  let libc: 'glibc' | 'musl' = 'glibc'
  let language: string | undefined
  const ins = instructions(text)
  if (!ins.some(i => i.op === 'FROM')) issues.push({ line: 1, level: 'error', message: 'No FROM instruction found.' })

  // Stage indices whose images run at build time only.
  const finalIdx = ins.map(i => i.op).lastIndexOf('FROM')
  for (let k = 0; k < ins.length; k++) {
    const { op, args, line } = ins[k]
    if (op === 'ARG') {
      for (const part of args.split(/\s+/)) {
        const [name, ...v] = part.split('=')
        if (name && !(name in vars) && !PLATFORM_ARG.test(name)) vars[name] = v.join('=').replace(/^["']|["']$/g, '')
      }
    } else if (op === 'FROM') {
      const m = substitute(args, vars).match(/^(?:--platform=(\S+)\s+)?(\S+)(?:\s+as\s+(\S+))?/i)
      if (!m) { issues.push({ line, level: 'error', message: 'Could not read this FROM line.' }); continue }
      const [, platform, image, alias] = m
      const parent = stages.find(s => s.alias?.toLowerCase() === image.toLowerCase())
      const internal = !!parent || image === 'scratch'
      const isFinal = k === finalIdx
      const root = parent?.root ?? image, rootLine = parent?.rootLine ?? line, rootPlatform = platform ?? parent?.rootPlatform
      stages.push({ image, alias, platform, line, internal, root, rootLine, rootPlatform })
      if (isFinal && rootPlatform && /BUILDPLATFORM/.test(rootPlatform) && root !== 'scratch')
        add(c, { ecosystem: 'build', name: 'Runtime stage uses --platform=$BUILDPLATFORM', key: 'final-buildplatform', line: platform ? line : rootLine, status: 'warn', title: 'Shipped image follows the build host, not the target', detail: `The final stage is based on a stage pinned to $BUILDPLATFORM (line ${platform ? line : rootLine}). Built on an x86 runner with --platform=linux/arm64, the result still has an amd64 base and fails on Arm nodes.`, fix: 'Keep --platform=$BUILDPLATFORM on build stages only; start the final stage from the image without it.', effort: 'S' })
      if (/alpine/i.test(root)) libc = 'musl'
      if (isFinal) {
        libc = /alpine/i.test(root) ? 'musl' : 'glibc'
        language = langOf(root) ?? language
      } else language = language ?? langOf(root)
      if (platform && /amd64|x86_64/.test(platform.replace(/\$\{[^}]*\}|\$\w+/g, ''))) {
        add(c, { ecosystem: 'build', name: `FROM --platform=${platform} (line ${line})`, key: `platform-${line}`, line, status: 'block', title: 'Stage is pinned to linux/amd64', detail: `FROM --platform=${platform} forces an x86 image; on Arm nodes it runs under emulation or not at all.`, fix: isFinal ? 'Remove --platform so buildx picks the target platform.' : 'Use --platform=$BUILDPLATFORM for build stages and cross-compile with TARGETARCH.', effort: 'S' })
      }
      if (!internal) {
        const buildOnly = !isFinal
        imageFinding(c, image, line, buildOnly ? 'build' : 'runtime', /alpine/i.test(image) ? 'musl' : 'glibc')
        if (buildOnly && platform && /BUILDPLATFORM/.test(args)) {
          // Cross-compiling stage: the image only has to exist for the build host.
          const f = c.out[c.out.length - 1]
          if (f?.ecosystem === 'image') f.detail = 'Runs on the build host (--platform=$BUILDPLATFORM).'
        }
      } else if (isFinal && parent && root !== 'scratch') {
        // FROM base AS final: the image behind the alias is what ships.
        imageFinding(c, root, rootLine, 'runtime', libc)
      }
    } else if (op === 'ENV') {
      for (const m of args.matchAll(/(\w+)[= ]("[^"]*"|\S+)/g)) vars[m[1]] = m[2].replace(/^"|"$/g, '')
      if (/x86_64-linux-gnu/.test(args)) pathFinding(c, line)
    } else if (op === 'COPY' || op === 'ADD') {
      const from = args.match(/--from=(\S+)/)?.[1]
      if (from && !stages.some(s => s.alias?.toLowerCase() === from.toLowerCase()) && !/^\d+$/.test(from)) imageFinding(c, substitute(from, vars), line, 'build')
      if (op === 'ADD') urlFindings(c, substitute(args, vars), args, line)
      if (/x86_64-linux-gnu/.test(args)) pathFinding(c, line)
    } else if (op === 'RUN') {
      const raw = args
      const cmd = substitute(raw, vars)
      urlFindings(c, cmd, raw, line)
      if (/x86_64-linux-gnu/.test(cmd)) pathFinding(c, line)
      const goarch = cmd.match(/GOARCH=(amd64|386)\b/)
      if (goarch) add(c, { ecosystem: 'build', name: `GOARCH=${goarch[1]}`, key: `goarch-${line}`, line, status: 'block', title: 'Go build hard-codes GOARCH', detail: `GOARCH=${goarch[1]} always produces an x86 binary, even in an arm64 image.`, fix: 'Use GOARCH=$TARGETARCH (declare ARG TARGETARCH in the stage) so buildx sets it per platform.', effort: 'S' })
      if (/\[\s*arch=amd64\s*\]/.test(cmd)) add(c, { ecosystem: 'apt', name: 'apt source [arch=amd64]', key: `aptarch-${line}`, line, status: 'block', title: 'apt repository pinned to amd64', detail: 'A sources.list entry declares [arch=amd64], so apt finds no packages from it on arm64.', fix: 'Use [arch=$(dpkg --print-architecture)] and confirm the vendor publishes arm64 packages.', effort: 'S' })
      if (/-march=(x86-64|native|haswell|skylake)|-mavx|-msse/.test(cmd)) add(c, { ecosystem: 'build', name: 'x86 compiler flags', key: `march-${line}`, line, status: 'block', title: 'x86-specific compiler flags', detail: 'Flags like -mavx, -msse or -march=x86-64 are rejected by aarch64 compilers.', fix: 'Guard them on TARGETARCH, or use -mcpu=neoverse-v1 / -march=armv8.2-a for arm64.', effort: 'S' })
      if (/(puppeteer|@puppeteer\/browsers)\s+(browsers\s+)?install\s+chrome\b|playwright\s+install\s+(--with-deps\s+)?(chrome|msedge)\b/.test(cmd))
        add(c, { ecosystem: 'binary', name: 'Chrome for Testing download', key: `chrome-${line}`, line, status: 'block', title: 'Google Chrome has no linux/arm64 build', detail: 'Chrome for Testing and branded Chrome/Edge are published for linux64 only, so this install fails or leaves no browser on arm64.', fix: 'Install the distro chromium package and point PUPPETEER_EXECUTABLE_PATH at it, or use "playwright install chromium", which ships arm64 builds.', effort: 'M' })
      for (const pkg of osPackages(cmd)) {
        const note = OS_PACKAGES[pkg.name]
        const eco: Ecosystem = pkg.mgr
        if (note) add(c, { ecosystem: eco, name: pkg.name, line, status: note.status, title: note.title, detail: note.detail, fix: note.fix, effort: note.effort ?? 'S' })
        else add(c, { ecosystem: eco, name: pkg.name, line, status: 'ok', title: `${pkg.mgr === 'apk' ? 'Alpine' : 'Debian/Ubuntu'} archive builds it for arm64`, detail: 'Packages from the main distro archives are published for arm64.', effort: 'S' })
      }
      for (const m of cmd.matchAll(/pip3?\s+install\s+([^&;|]+)/g)) {
        for (const tok of m[1].split(/\s+/)) {
          if (!tok || tok.startsWith('-') || /[/\\]|\.txt$|\.whl$|^\./.test(tok)) continue
          const r = reqLine(tok)
          if (r) add(c, { ecosystem: 'pypi', name: r.name, version: r.version, line, status: 'pending', lookup: 'pypi', libc, title: 'Checking PyPI for arm64 wheels', detail: '', effort: 'S' })
        }
      }
    }
  }
  if (stages.length && !ins.some(i => i.op === 'ARG' && /\bTARGET(ARCH|PLATFORM)\b/.test(i.args)) && c.out.some(f => f.file === c.file && f.status === 'block' && (f.ecosystem === 'binary' || f.ecosystem === 'build')))
    issues.push({ line: 1, level: 'info', message: 'No ARG TARGETARCH declared; add it to stages that download or compile architecture-specific code.' })
  return { stages, libc, language, issues }
}

function langOf(image: string): string | undefined {
  const n = image.toLowerCase()
  if (/python|pypy/.test(n)) return 'Python'
  if (/node|bun|deno/.test(n)) return 'Node.js'
  if (/golang/.test(n)) return 'Go'
  if (/temurin|openjdk|corretto|maven|gradle|jdk|jre/.test(n)) return 'Java'
  if (/rust/.test(n)) return 'Rust'
  if (/dotnet|aspnet/.test(n)) return '.NET'
  if (/ruby/.test(n)) return 'Ruby'
  if (/php/.test(n)) return 'PHP'
  return undefined
}

function pathFinding(c: Ctx, line: number) {
  add(c, { ecosystem: 'build', name: '/usr/lib/x86_64-linux-gnu', key: `libpath-${line}`, line, status: 'warn', title: 'Hard-coded x86_64 library path', detail: 'Debian puts arm64 libraries in /usr/lib/aarch64-linux-gnu, so this path does not exist on arm64.', fix: 'Derive it: /usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH) or ${TARGETARCH}-specific ARGs.', effort: 'S' })
}

function urlFindings(c: Ctx, cmd: string, raw: string, line: number) {
  for (const m of cmd.matchAll(/https?:\/\/[^\s"'`;|&)]+/g)) {
    const url = m[0]
    // Variables that resolve to the architecture count as multi-arch, even after defaults were substituted.
    const rawUrls = [...raw.matchAll(/https?:\/\/[^\s"'`;|&)]+/g)].map(x => x[0])
    const parametrised = rawUrls.some(r => ARCH_VAR.test(r) && sameHost(r, url))
    if (parametrised) {
      add(c, { ecosystem: 'binary', name: shortUrl(url), key: `url-${line}-${shortUrl(url)}`, line, status: 'ok', title: 'Download is parameterised by architecture', detail: 'The URL uses TARGETARCH or uname, so buildx fetches the right binary.', effort: 'S' })
      continue
    }
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const tok = path.match(X86_TOKEN)
    if (tok) add(c, { ecosystem: 'binary', name: shortUrl(url), key: `url-${line}-${shortUrl(url)}`, line, status: 'block', title: `Downloads an ${tok[1]} binary`, detail: `${url} is an x86 build. In an arm64 image it fails with "exec format error".`, fix: suggestArchFix(url, tok[1]), effort: 'S' })
  }
}

const sameHost = (a: string, b: string) => a.split('/')[2] === b.split('/')[2]
const shortUrl = (u: string) => u.replace(/^https?:\/\//, '').split('/').filter(Boolean).slice(-1)[0] ?? u

export function suggestArchFix(url: string, token: string): string {
  const t = token.toLowerCase()
  const arm = t === 'x86_64' || t === 'x86-64' ? 'aarch64' : t === 'x64' ? 'arm64' : t === 'amd64' ? 'arm64' : 'arm64'
  if (t === 'amd64') return `Declare ARG TARGETARCH and use ${url.replace(/amd64/i, '${TARGETARCH}')}. Confirm the vendor publishes an ${arm} asset.`
  return `Map TARGETARCH to the vendor's naming (amd64 -> ${token}, arm64 -> ${arm}) in a shell case, then download ${url.replace(new RegExp(token, 'i'), '${ARCH}')}.`
}

export function osPackages(cmd: string): { mgr: 'apt' | 'apk'; name: string }[] {
  const out: { mgr: 'apt' | 'apk'; name: string }[] = []
  for (const seg of cmd.split(/&&|;|\|\|/)) {
    const m = seg.match(/\b(apt-get|apt|apk)\s+(?:[-\w=]+\s+)*?(install|add)\b(.*)$/s)
    if (!m) continue
    const mgr = m[1] === 'apk' ? 'apk' : 'apt'
    for (const tok of m[3].trim().split(/\s+/)) {
      if (!tok || tok.startsWith('-') || tok.includes('$') || tok.includes('/') || tok === '\\') continue
      const name = tok.replace(/[=<>].*$/, '').replace(/^["']|["']$/g, '')
      if (/^[a-z0-9][a-z0-9+.-]*$/.test(name)) out.push({ mgr, name })
    }
  }
  return out
}

// ---------- Compose and Kubernetes ----------

function indentOf(l: string) { return l.match(/^\s*/)![0].length }

export function parseCompose(file: string, text: string, out: Finding[], builtHere: Set<string>): { services: string[]; issues: FileIssue[] } {
  const lines = text.split(/\r?\n/)
  const services: string[] = []
  const issues: FileIssue[] = []
  let inServices = false, svcIndent = -1, current = ''
  let hasBuild = false
  // x-defaults: &name blocks (and services with an anchor) that set image or build, merged with <<: *name.
  const anchors = new Map<string, { image?: string; line: number; build: boolean }>()
  let anchor = '', anchorIndent = -1
  const pendingImage: { image: string; line: number }[] = []
  const flush = () => {
    for (const p of pendingImage) {
      const c: Ctx = { file, service: current, out }
      const ref = parseImageRef(p.image)
      if (hasBuild || (ref && builtHere.has(lastSeg(ref.repo)))) add(c, { ecosystem: 'image', name: p.image, line: p.line, status: 'ok', title: 'Built from this repo', detail: 'Readiness follows the Dockerfile scan.', effort: 'S' })
      else imageFinding(c, p.image, p.line, 'runtime')
    }
    pendingImage.length = 0
    hasBuild = false
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim() || l.trim().startsWith('#')) continue
    const ind = indentOf(l)
    const def = l.match(/^\s*[\w.-]+:\s*&([\w.-]+)\s*$/)
    if (def) { anchor = def[1]; anchorIndent = ind; anchors.set(anchor, { line: i + 1, build: false }) }
    else if (anchor && ind <= anchorIndent) anchor = ''
    else if (anchor && ind > anchorIndent) {
      const a = anchors.get(anchor)!
      const im = l.match(/^\s*image:\s*["']?([^"'\s#]+)/)
      if (im) { a.image = im[1]; a.line = i + 1 }
      if (/^\s*build:/.test(l)) a.build = true
    }
    if (ind === 0) { if (inServices) flush(); inServices = /^services:\s*$/.test(l); current = ''; svcIndent = -1; continue }
    if (!inServices) continue
    if (svcIndent < 0) svcIndent = ind
    if (ind === svcIndent) {
      flush()
      const m = l.trim().match(/^([\w.-]+):/)
      if (m) { current = m[1]; services.push(current) }
      continue
    }
    if (!current) continue
    const img = l.match(/^\s*image:\s*["']?([^"'\s#]+)/)
    if (img) { pendingImage.length = 0; pendingImage.push({ image: substitute(img[1], {}), line: i + 1 }) }
    if (/^\s*build:/.test(l)) hasBuild = true
    if (ind > svcIndent && /^\s*<<:/.test(l)) for (const m of l.matchAll(/\*([\w.-]+)/g)) {
      const a = anchors.get(m[1])
      if (!a) continue
      if (a.build) hasBuild = true
      if (a.image && !pendingImage.length) pendingImage.push({ image: substitute(a.image, {}), line: i + 1 })
    }
    const plat = l.match(/^\s*platform:\s*["']?([^"'\s#]+)/)
    if (plat && /amd64|x86_64/.test(plat[1])) add({ file, service: current, out }, { ecosystem: 'k8s', name: `platform: ${plat[1]}`, key: 'compose-platform', line: i + 1, status: 'block', title: 'Service pinned to linux/amd64', detail: 'platform: linux/amd64 makes Docker pull the x86 image and run it under emulation on Arm hosts.', fix: 'Remove the platform key once the image is multi-arch.', effort: 'S' })
  }
  if (inServices) flush()
  if (!services.length) issues.push({ line: 1, level: 'error', message: 'No services: block found.' })
  return { services, issues }
}

const lastSeg = (repo: string) => repo.split('/').pop()!.toLowerCase()

export function parseK8s(file: string, text: string, out: Finding[], builtHere: Set<string>): { workloads: string[]; issues: FileIssue[] } {
  const workloads: string[] = []
  const issues: FileIssue[] = []
  const lines = text.split(/\r?\n/)
  let start = 0
  const docs: { from: number; lines: string[] }[] = []
  for (let i = 0; i <= lines.length; i++) {
    if (i === lines.length || /^---/.test(lines[i])) { docs.push({ from: start, lines: lines.slice(start, i) }); start = i + 1 }
  }
  for (const d of docs) {
    const body = d.lines.join('\n')
    const kind = body.match(/^kind:\s*(\S+)/m)?.[1]
    if (!kind) continue
    const metaIdx = d.lines.findIndex(l => /^metadata:\s*$/.test(l))
    let name = ''
    if (metaIdx >= 0) for (let j = metaIdx + 1; j < d.lines.length && /^\s/.test(d.lines[j]); j++) { const m = d.lines[j].match(/^\s{1,4}name:\s*["']?([^"'\s#]+)/); if (m) { name = m[1]; break } }
    if (!/^(Deployment|StatefulSet|DaemonSet|Job|CronJob|Pod|ReplicaSet|Rollout)$/.test(kind)) continue
    if (!name) { issues.push({ line: d.from + 1, level: 'warn', message: `${kind} without metadata.name; skipped.` }); continue }
    workloads.push(name)
    const c: Ctx = { file, service: name, out }
    d.lines.forEach((l, j) => {
      const line = d.from + j + 1
      const img = l.match(/^\s*-?\s*image:\s*["']?([^"'\s#]+)/)
      if (img) {
        const ref = parseImageRef(img[1])
        if (ref && builtHere.has(lastSeg(ref.repo))) add(c, { ecosystem: 'image', name: ref.canonical, line, status: 'ok', title: 'Built from this repo', detail: `Readiness follows the ${lastSeg(ref.repo)} Dockerfile scan; publish it as a multi-arch image.`, effort: 'S' })
        else imageFinding(c, img[1], line, 'runtime')
      }
      const sel = l.match(/^\s*(?:beta\.)?kubernetes\.io\/arch:\s*["']?(amd64|arm64)/)
      if (sel?.[1] === 'amd64') add(c, { ecosystem: 'k8s', name: 'nodeSelector arch=amd64', key: 'arch-selector', line, status: 'warn', title: 'Workload pinned to amd64 nodes', detail: 'nodeSelector kubernetes.io/arch: amd64 keeps it off Arm nodes even once the images are ready.', fix: 'Switch to arm64 (see the generated patch) after the images are multi-arch.', effort: 'S' })
      if (/^\s*-\s*["']?amd64["']?\s*$/.test(l) && d.lines.slice(Math.max(0, j - 4), j).some(x => /kubernetes\.io\/arch/.test(x)))
        add(c, { ecosystem: 'k8s', name: 'nodeAffinity arch=amd64', key: 'arch-affinity', line, status: 'warn', title: 'Node affinity requires amd64', detail: 'The affinity rule only allows amd64 nodes.', fix: 'Add arm64 to the values list, or replace with the generated arm64 patch.', effort: 'S' })
    })
  }
  return { workloads, issues }
}

// ---------- Language lockfiles ----------

export function reqLine(s: string): { name: string; version?: string } | null {
  const t = s.replace(/#.*$/, '').split(';')[0].trim()
  if (!t || t.startsWith('-') || /^(git\+|https?:)/.test(t)) return null
  const m = t.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:===?\s*([\w.!+-]+))?/)
  if (!m) return null
  return { name: m[1].toLowerCase().replace(/[._]+/g, '-'), version: m[2] }
}

export function parseRequirements(c: Ctx, text: string, libc: 'glibc' | 'musl'): FileIssue[] {
  const issues: FileIssue[] = []
  text.split(/\r?\n/).forEach((l, i) => {
    const t = l.trim()
    if (!t || t.startsWith('#')) return
    if (/^-(r|c|e|-requirement|-constraint|-editable)\b/.test(t)) { issues.push({ line: i + 1, level: 'info', message: `Skipped "${t}". Upload the referenced file too.` }); return }
    if (t.startsWith('-')) return
    const r = reqLine(t)
    if (!r) { issues.push({ line: i + 1, level: 'warn', message: `Could not read "${t}".` }); return }
    if (!r.version) issues.push({ line: i + 1, level: 'info', message: `${r.name} is not pinned; checking the latest release.` })
    if (/platform_machine\s*==\s*["']x86_64/.test(t)) issues.push({ line: i + 1, level: 'warn', message: `${r.name} is only installed on x86_64; arm64 builds will skip it.` })
    add(c, { ecosystem: 'pypi', name: r.name, version: r.version, line: i + 1, status: 'pending', lookup: 'pypi', libc, title: 'Checking PyPI for arm64 wheels', detail: '', effort: 'S' })
  })
  return issues
}

export function parsePoetry(c: Ctx, text: string, libc: 'glibc' | 'musl'): FileIssue[] {
  const lines = text.split(/\r?\n/)
  let name = '', line = 0
  lines.forEach((l, i) => {
    if (/^\[\[package\]\]/.test(l)) { name = ''; line = i + 1 }
    const n = l.match(/^name = "([^"]+)"/); if (n) name = n[1].toLowerCase().replace(/[._]+/g, '-')
    const v = l.match(/^version = "([^"]+)"/)
    if (v && name) { add(c, { ecosystem: 'pypi', name, version: v[1], line, status: 'pending', lookup: 'pypi', libc, title: 'Checking PyPI for arm64 wheels', detail: '', effort: 'S' }); name = '' }
  })
  return c.out.some(f => f.file === c.file) ? [] : [{ line: 1, level: 'error', message: 'No [[package]] entries found.' }]
}

export function parsePackageLock(c: Ctx, text: string): FileIssue[] {
  let j: { lockfileVersion?: number; packages?: Record<string, { version?: string; hasInstallScript?: boolean; os?: string[]; cpu?: string[]; optional?: boolean; dev?: boolean }>; dependencies?: Record<string, { version?: string }> }
  try { j = JSON.parse(text) } catch (e) {
    const pos = Number(String(e).match(/position (\d+)/)?.[1] ?? 0)
    return [{ line: lineOf(text, pos), level: 'error', message: 'Not valid JSON: ' + (e instanceof Error ? e.message : String(e)) }]
  }
  if (!j.packages) return [{ line: 1, level: 'error', message: `lockfileVersion ${j.lockfileVersion ?? 1} has no "packages" map. Regenerate with npm 7+ (npm install --package-lock-only).` }]
  let pure = 0
  for (const [path, p] of Object.entries(j.packages)) {
    if (!path) continue
    const name = path.replace(/^.*node_modules\//, '')
    // Platform-specific optional packages (e.g. @esbuild/linux-x64) are picked per platform by npm.
    if (p.cpu || p.os) continue
    const known = NPM[name]
    const line = lineOf(text, text.indexOf(`"${path}"`))
    if (known) add(c, { ecosystem: 'npm', name, version: p.version, line, status: known.status, title: known.title, detail: known.detail, fix: known.fix, effort: known.effort ?? 'S', source: 'curated' })
    else if (p.hasInstallScript) add(c, { ecosystem: 'npm', name, version: p.version, line, status: 'pending', lookup: 'npm', title: 'Checking npm for a native addon', detail: '', effort: 'S' })
    else pure++
  }
  if (pure) add(c, { ecosystem: 'npm', name: `${pure} pure-JS packages`, key: 'pure', line: 1, status: 'ok', title: 'No install scripts', detail: `${pure} packages have no install step, so they are architecture-neutral.`, effort: 'S' })
  return []
}

export function parseGoMod(c: Ctx, text: string): FileIssue[] {
  const lines = text.split(/\r?\n/)
  let inReq = false, count = 0
  lines.forEach((l, i) => {
    const t = l.replace(/\/\/.*$/, '').trim()
    if (/^require\s*\($/.test(t)) { inReq = true; return }
    if (inReq && t === ')') { inReq = false; return }
    const m = inReq ? t.match(/^(\S+)\s+(v\S+)/) : t.match(/^require\s+(\S+)\s+(v\S+)/)
    if (!m) return
    count++
    const note = GO[m[1]]
    if (note) add(c, { ecosystem: 'go', name: m[1], version: m[2], line: i + 1, status: note.status, title: note.title, detail: note.detail, fix: note.fix, effort: note.effort ?? 'S', source: 'curated' })
  })
  if (!/^module\s+/m.test(text)) return [{ line: 1, level: 'error', message: 'No module line found.' }]
  add(c, { ecosystem: 'go', name: `${count} Go modules`, key: 'go-toolchain', line: 1, status: 'ok', title: 'Go cross-compiles to arm64', detail: 'Pure-Go modules build for linux/arm64 with GOARCH=arm64 and no other changes.', effort: 'S' })
  return []
}

function cmpVer(a: string, b: string) {
  const pa = a.split(/[.-]/).map(n => parseInt(n) || 0), pb = b.split(/[.-]/).map(n => parseInt(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d }
  return 0
}

function javaDep(c: Ctx, g: string, a: string, v: string | undefined, classifier: string | undefined, line: number) {
  const key = `${g}:${a}`
  const note = JAVA[key]
  if (classifier && /x86_64|x86-64|amd64/.test(classifier)) {
    add(c, { ecosystem: 'maven', name: `${key}:${classifier}`, version: v, line, status: 'block', title: 'Native classifier is x86_64 only', detail: `The ${classifier} classifier bundles only x86 JNI libraries.`, fix: `Add the ${classifier.replace(/x86_64|x86-64|amd64/, 'aarch_64')} classifier (or select it with a Maven profile on os.arch=aarch64).`, effort: 'S' })
    return
  }
  if (note) {
    const old = note.minVersion && v && !v.includes('$') && cmpVer(v, note.minVersion) < 0
    add(c, { ecosystem: 'maven', name: key, version: v, line, status: old ? 'warn' : note.status, title: old ? `${a} ${v} predates aarch64 support` : note.title, detail: old ? `${note.detail} Upgrade to ${note.minVersion} or later.` : note.detail, fix: old ? `Upgrade to ${note.minVersion}+.` : note.fix, effort: note.effort ?? 'S', source: 'curated' })
  } else if (/jni|native/i.test(a)) {
    add(c, { ecosystem: 'maven', name: key, version: v, line, status: 'warn', title: 'Contains JNI code', detail: 'The artifact name suggests bundled native libraries. Check that the jar includes linux-aarch64 natives.', fix: 'unzip -l the jar and look for aarch64 or aarch_64 entries.', effort: 'S' })
  }
}

export function parsePom(c: Ctx, text: string): FileIssue[] {
  const props: Record<string, string> = {}
  for (const m of text.matchAll(/<properties>([\s\S]*?)<\/properties>/g)) for (const p of m[1].matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) props[p[1]] = p[2].trim()
  let n = 0
  for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const get = (t: string) => m[1].match(new RegExp(`<${t}>\\s*([^<]+?)\\s*</${t}>`))?.[1]
    const g = get('groupId'), a = get('artifactId')
    if (!g || !a) continue
    n++
    const v = get('version')?.replace(/\$\{([\w.-]+)\}/g, (all, k) => props[k] ?? all)
    javaDep(c, g, a, v, get('classifier')?.replace(/\$\{([\w.-]+)\}/g, (all, k) => props[k] ?? all), lineOf(text, m.index!))
  }
  if (!n) return [{ line: 1, level: 'warn', message: 'No <dependency> entries found.' }]
  add(c, { ecosystem: 'maven', name: 'JVM bytecode', key: 'jvm', line: 1, status: 'ok', title: 'Java bytecode is architecture-neutral', detail: `${n} dependencies scanned. Only JNI libraries need arm64 natives; use an arm64 JDK base image (Temurin, Corretto and Microsoft builds all publish one).`, effort: 'S' })
  return []
}

export function parseGradle(c: Ctx, text: string): FileIssue[] {
  let n = 0
  text.split(/\r?\n/).forEach((l, i) => {
    const m = l.match(/['"(\s-]([\w.-]+):([\w.-]+):([\w.${}-]+)(?::([\w.-]+))?/)
    if (!m || /^\s*(\/\/|#)/.test(l)) return
    n++
    javaDep(c, m[1], m[2], m[3].replace(/\s*\(.*$/, ''), m[4], i + 1)
  })
  if (!n) return [{ line: 1, level: 'warn', message: 'No group:artifact:version coordinates found.' }]
  add(c, { ecosystem: 'maven', name: 'JVM bytecode', key: 'jvm', line: 1, status: 'ok', title: 'Java bytecode is architecture-neutral', detail: `${n} dependencies scanned. Only JNI libraries need arm64 natives.`, effort: 'S' })
  return []
}

/** *-sys crates that are bindings to the OS or to JS, not to a C library that has to be built for Linux arm64. */
const CARGO_NOT_NATIVE = /^(windows|winapi|js|web|linux-raw|core-foundation|security-framework|fsevent|mach2?|objc|ndk|wasi|hermit|redox_?syscall|io-kit|system-configuration)(-.*)?-sys$|^winapi-/

export function parseCargo(c: Ctx, text: string): FileIssue[] {
  let name = '', line = 0, n = 0
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\[\[package\]\]/.test(l)) { name = ''; line = i + 1 }
    const nm = l.match(/^name = "([^"]+)"/); if (nm) name = nm[1]
    const v = l.match(/^version = "([^"]+)"/)
    if (v && name) {
      n++
      const note = CARGO[name]
      if (note) add(c, { ecosystem: 'cargo', name, version: v[1], line, status: note.status, title: note.title, detail: note.detail, fix: note.fix, effort: note.effort ?? 'S', source: 'curated' })
      else if (name.endsWith('-sys') && !CARGO_NOT_NATIVE.test(name)) add(c, { ecosystem: 'cargo', name, version: v[1], line, status: 'warn', title: 'Links a C library', detail: '*-sys crates compile or link native code; cross builds need the aarch64 headers.', fix: 'Build on an arm64 runner, or install the target dev package.', effort: 'S' })
      name = ''
    }
  })
  if (!n) return [{ line: 1, level: 'error', message: 'No [[package]] entries found.' }]
  add(c, { ecosystem: 'cargo', name: `${n} crates`, key: 'rust', line: 1, status: 'ok', title: 'Rust targets aarch64-unknown-linux-gnu', detail: 'Tier 1 target; pure-Rust crates need no changes.', effort: 'S' })
  return []
}

// ---------- yarn.lock and pnpm-lock.yaml ----------
//
// Formats, from the package managers' own source and docs:
//   Yarn 1:  yarnpkg/yarn src/lockfile/stringify.js + parse.js ("# yarn lockfile v1", `name@range` keys, 2-space fields).
//   Yarn 2+: yarnpkg/berry packages/yarnpkg-core/sources/Project.ts (`__metadata.version`, `resolution: "ident@protocol:ref"`).
//   pnpm:    pnpm/pnpm docs/lockfile-format.md and pnpm/spec lockfile/{6.0,9.0}.md.
// None of them records whether a package runs an install script, except pnpm 8 (lockfileVersion 6.x) `requiresBuild: true`.

/** Most live npm lookups a scan starts for packages whose install scripts a lockfile does not record (shared by all lockfiles in the scan). */
export const NPM_LOOKUP_LIMIT = 100

/** A dependency of a package that is a strong sign the package builds or loads native code. */
const NATIVE_HINT = /^(node-gyp|node-gyp-build|node-pre-gyp|@mapbox\/node-pre-gyp|prebuild-install|prebuildify|node-addon-api|nan|bindings|cmake-js|napi-macros)$/

interface NodePkg { name: string; version: string; line: number; installScript?: boolean; hint?: boolean }
interface NodeScan {
  pkgs: NodePkg[]
  /** workspace, link, portal and file entries: the project's own code. */
  local: { count: number; line: number }
  /** git, tarball URL and other non-registry entries. */
  remote: { name: string; version?: string; spec: string; line: number }[]
}

const newScan = (): NodeScan => ({ pkgs: [], local: { count: 0, line: 0 }, remote: [] })
const addLocal = (s: NodeScan, line: number) => { if (!s.local.count++) s.local.line = line }

/** An unreadable or unsupported lockfile is an error AND an unknown finding, so the service never looks ready. */
function unreadable(c: Ctx, label: string, message: string, line = 1): FileIssue[] {
  add(c, { ecosystem: 'npm', name: label, key: `unreadable|${c.file}`, line, status: 'unknown', title: 'Lockfile could not be read', detail: message, fix: 'Regenerate the lockfile with a current package manager and import it again.', effort: 'S' })
  return [{ line, level: 'error', message }]
}

/** Turns scanned packages into findings. Shared by yarn.lock and pnpm-lock.yaml. */
function finishNodeLock(c: Ctx, scan: NodeScan, label: string): FileIssue[] {
  const issues: FileIssue[] = []
  const seen = new Map<string, NodePkg>()
  for (const p of scan.pkgs) {
    const prev = seen.get(`${p.name}@${p.version}`)
    if (!prev) seen.set(`${p.name}@${p.version}`, { ...p })
    else { prev.installScript ||= p.installScript; prev.hint ||= p.hint }
  }
  const versions = new Map<string, number>()
  for (const p of seen.values()) versions.set(p.name, (versions.get(p.name) ?? 0) + 1)
  // Findings are keyed by name, or name@version when the lockfile holds several versions of it.
  const key = (p: NodePkg) => (versions.get(p.name)! > 1 ? `${p.name}@${p.version}` : p.name)

  let budget = Math.max(0, NPM_LOOKUP_LIMIT - c.out.filter(f => f.lookup === 'npm' && f.status === 'pending').length)
  const unchecked: NodePkg[] = []
  // Known install scripts first, then packages that depend on a native-build helper, then file order.
  const rank = (p: NodePkg) => (p.installScript ? 0 : p.hint ? 1 : 2)
  const ordered = [...seen.values()].map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(x => x.p)
  for (const p of ordered) {
    const known = NPM[p.name]
    if (known) add(c, { ecosystem: 'npm', name: p.name, key: key(p), version: p.version, line: p.line, status: known.status, title: known.title, detail: known.detail, fix: known.fix, effort: known.effort ?? 'S', source: 'curated' })
    else if (budget > 0) { budget--; add(c, { ecosystem: 'npm', name: p.name, key: key(p), version: p.version, line: p.line, status: 'pending', lookup: 'npm', title: 'Checking npm for a native addon', detail: '', effort: 'S' }) }
    else unchecked.push(p)
  }
  if (unchecked.length) {
    unchecked.sort((a, b) => a.line - b.line)
    const msg = `${label} does not record install scripts. ${unchecked.length} of ${seen.size} packages were not looked up on npm (limit ${NPM_LOOKUP_LIMIT} npm lookups per scan), so they are not counted as pure JavaScript.`
    add(c, { ecosystem: 'npm', name: `${unchecked.length} packages`, key: `unchecked|${c.file}`, line: unchecked[0].line, status: 'unknown', title: 'Install scripts not checked', detail: msg, fix: 'Check these for node-gyp, prebuild or binding.gyp. Or import a package-lock.json made with npm install --package-lock-only (versions can differ from this lockfile): npm records install scripts there.', effort: 'M' })
    issues.push({ line: unchecked[0].line, level: 'warn', message: msg })
  }
  if (scan.local.count) issues.push({ line: scan.local.line, level: 'info', message: `${scan.local.count} local entries (workspace, link, portal or file) are your own code, not installed from npm, and are not scanned.` })
  for (const r of scan.remote) {
    add(c, { ecosystem: 'npm', name: r.name, key: `${r.name}@${r.spec}`, version: r.version, line: r.line, status: 'unknown', title: 'Not installed from the npm registry', detail: `Installed from ${r.spec}. A lockfile entry like this has no install-script data and npm cannot be asked about it.`, fix: 'Look in that repository or archive for node-gyp, prebuild or binding.gyp, and build it on arm64.', effort: 'M' })
    issues.push({ line: r.line, level: 'warn', message: `${r.name} comes from ${r.spec}, not the npm registry, so it cannot be checked.` })
  }
  if (!scan.pkgs.length && !scan.remote.length) issues.push({ line: 1, level: 'info', message: 'No packages from the npm registry in this lockfile.' })
  return issues
}

const unquote = (s: string) => {
  const t = s.trim()
  if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) { try { return JSON.parse(t) as string } catch { return t.slice(1, -1) } }
  if (t.length > 1 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

/** `name@range` split on the first @ after position 0, so @scope/name works. */
function splitSpec(spec: string): { name: string; range: string } {
  const at = spec.indexOf('@', 1)
  return at < 0 ? { name: spec, range: '' } : { name: spec.slice(0, at), range: spec.slice(at + 1) }
}

/** Yarn 1 range kinds. A registry range is a semver range, a tag, or npm:alias@range. */
function yarnRangeKind(range: string): 'registry' | 'local' | 'remote' {
  if (/^(link|file|portal|workspace):/.test(range)) return 'local'
  if (/^npm:/.test(range)) return 'registry'
  if (/^(git|github|gitlab|bitbucket|https?|ssh):|^git[+@]|^[\w.-]+\/[\w.-]+(#.*)?$/.test(range)) return 'remote'
  return 'registry'
}

function splitYarn1Keys(raw: string): string[] {
  return (raw.match(/"(?:[^"\\]|\\.)*"|[^,\s][^,]*/g) ?? []).map(k => unquote(k.trim()))
}

export function parseYarnClassic(c: Ctx, text: string): FileIssue[] {
  const L = text.split(/\r?\n/)
  const scan = newScan()
  for (let i = 0; i < L.length; i++) {
    const l = L[i]
    if (!l || l[0] === ' ' || l[0] === '#' || !l.endsWith(':')) continue
    const start = i
    const keys = splitYarn1Keys(l.slice(0, -1))
    let version = '', section = ''
    const deps: string[] = []
    for (i++; i < L.length && (L[i] === '' || L[i][0] === ' '); i++) {
      const f = L[i]
      if (/^ {4}\S/.test(f)) { if (/^(dependencies|optionalDependencies)$/.test(section)) deps.push(unquote(f.trim().match(/^"(?:[^"\\]|\\.)*"|^\S+/)![0])); continue }
      const m = f.match(/^ {2}(\w+):?(?: (.*))?$/)
      if (!m) continue
      section = m[1]
      if (m[1] === 'version') version = unquote(m[2] ?? '')
    }
    i--
    if (!keys.length || !version) continue
    const line = start + 1
    let { name, range } = splitSpec(keys[0])
    const kind = yarnRangeKind(range)
    if (kind === 'local') addLocal(scan, line)
    else if (kind === 'remote') scan.remote.push({ name, version, spec: range.replace(/#.*$/, ''), line })
    else {
      // "alias@npm:real@^1": the real package is what gets installed.
      if (range.startsWith('npm:')) name = splitSpec(range.slice(4)).name
      scan.pkgs.push({ name, version, line, hint: deps.some(d => NATIVE_HINT.test(d)) })
    }
  }
  return finishNodeLock(c, scan, 'yarn.lock')
}

/** `__metadata.version` values read: Yarn 2.4 (4) up to LOCKFILE_VERSION in Project.ts on master (10). */
const BERRY_VERSIONS = [4, 10] as const

export function parseYarnBerry(c: Ctx, text: string): FileIssue[] {
  const L = text.split(/\r?\n/)
  const metaAt = L.findIndex(l => /^__metadata:/.test(l))
  let version = 0
  for (let i = metaAt + 1; i < L.length && (L[i] === '' || L[i][0] === ' '); i++) {
    const m = L[i].match(/^\s+version:\s*"?(\d+)"?\s*$/)
    if (m) version = Number(m[1])
  }
  const [lo, hi] = BERRY_VERSIONS
  if (!version) return unreadable(c, 'yarn.lock', 'The __metadata block has no version, so the yarn.lock layout is unknown.', metaAt + 1)
  if (version < lo || version > hi) return unreadable(c, 'yarn.lock', `yarn.lock __metadata version ${version} is not supported. This tool reads versions ${lo} to ${hi}. Run yarn install with a current Yarn to rewrite it.`, metaAt + 1)
  const scan = newScan()
  for (let i = 0; i < L.length; i++) {
    const l = L[i]
    if (!l || l[0] === ' ' || l[0] === '#' || !l.endsWith(':') || /^__metadata:/.test(l)) continue
    const start = i
    let resolution = '', ver = '', conditions = '', section = ''
    const deps: string[] = []
    for (i++; i < L.length && (L[i] === '' || L[i][0] === ' '); i++) {
      const f = L[i]
      if (/^ {4}\S/.test(f)) { if (section === 'dependencies') deps.push(unquote(f.trim().match(/^"(?:[^"\\]|\\.)*"|^[^\s:]+/)![0])); continue }
      const m = f.match(/^ {2}(\w+):(?: (.*))?$/)
      if (!m) continue
      section = m[1]
      if (m[1] === 'resolution') resolution = unquote(m[2] ?? '')
      if (m[1] === 'version') ver = unquote(m[2] ?? '')
      if (m[1] === 'conditions') conditions = m[2] ?? ''
    }
    i--
    if (!resolution) continue
    const line = start + 1
    // The resolution is the real identity, even for aliases: "string-width-cjs@npm:string-width@^4" resolves to "string-width@npm:4.2.3".
    const { name, range: ref } = splitSpec(resolution)
    if (/^patch:/.test(ref)) continue // A patched copy of an entry that is listed on its own.
    if (/^(workspace|link|portal|file):/.test(ref)) addLocal(scan, line)
    else if (/^npm:/.test(ref)) {
      if (conditions) continue // os/cpu-conditional packages are picked per platform by Yarn.
      scan.pkgs.push({ name, version: ver || ref.slice(4).split('::')[0], line, hint: deps.some(d => NATIVE_HINT.test(d)) })
    } else scan.remote.push({ name, version: ver || undefined, spec: ref.replace(/#.*$/, ''), line })
  }
  return finishNodeLock(c, scan, 'yarn.lock')
}

export function parseYarnLock(c: Ctx, text: string): FileIssue[] {
  if (/^__metadata:/m.test(text)) return parseYarnBerry(c, text)
  const v = text.match(/^# yarn lockfile v(\d+)/m)
  if (v) return v[1] === '1' ? parseYarnClassic(c, text) : unreadable(c, 'yarn.lock', `"# yarn lockfile v${v[1]}" is not a yarn.lock format this tool reads (Yarn 1 writes v1, Yarn 2 and later write a __metadata block).`)
  return unreadable(c, 'yarn.lock', 'Not a recognised yarn.lock: expected "# yarn lockfile v1" (Yarn 1) or a "__metadata:" block (Yarn 2 and later).')
}

/** One entry key of a pnpm packages/snapshots section: 2-space indent, quoted or not (unquoted keys can contain colons, e.g. name@file:path). */
function pnpmKey(l: string): string | null {
  let m = l.match(/^ {2}'((?:[^']|'')*)':(?: .*)?$/)
  if (m) return m[1].replace(/''/g, "'")
  m = l.match(/^ {2}("(?:[^"\\]|\\.)*"):(?: .*)?$/)
  if (m) return unquote(m[1])
  m = l.match(/^ {2}([^\s'"#].*?):(?: \{\})?$/)
  return m ? m[1] : null
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/

export function parsePnpmLock(c: Ctx, text: string): FileIssue[] {
  const all = text.split(/\r?\n/)
  // pnpm can put an environment (config dependencies) document first and the project lockfile last, split by "---".
  const docs: { start: number; end: number }[] = []
  let from = 0
  all.forEach((l, i) => { if (/^---\s*$/.test(l)) { docs.push({ start: from, end: i }); from = i + 1 } })
  docs.push({ start: from, end: all.length })
  const live = docs.filter(d => all.slice(d.start, d.end).some(l => l.trim() && !l.trim().startsWith('#')))
  if (!live.length) return unreadable(c, 'pnpm-lock.yaml', 'The file is empty.')
  const doc = live[live.length - 1]
  const L = all.slice(doc.start, doc.end)
  const at = (i: number) => doc.start + i + 1
  const issues: FileIssue[] = []
  if (live.length > 1) issues.push({ line: live[0].start + 1, level: 'info', message: `Skipped ${live.length - 1} environment document${live.length > 2 ? 's' : ''} before line ${doc.start + 1}; the project lockfile is the last document.` })

  const vm = L.join('\n').match(/^[ \t]*["']?lockfileVersion["']?[ \t]*:[ \t]*["']?([\d.]+)["']?/m)
  if (!vm) return unreadable(c, 'pnpm-lock.yaml', 'No lockfileVersion found, so the pnpm-lock.yaml layout is unknown.', doc.start + 1)
  const lv = vm[1]
  const v9 = /^9\./.test(lv), v6 = /^6\./.test(lv)
  if (!v9 && !v6) {
    const old = /^[1-5]\./.test(lv)
    return unreadable(c, 'pnpm-lock.yaml', `pnpm-lock.yaml lockfileVersion ${lv} is not supported. This tool reads 9.x (pnpm 9 and later) and 6.x (pnpm 8). ${old ? 'Versions 5.x and older were written by pnpm 7 and earlier.' : 'This is a newer or experimental format.'} Regenerate it with a current pnpm using its default lockfile format.`, at(L.findIndex(l => /lockfileVersion/.test(l))))
  }

  interface Entry { key: string; line: number; platform: boolean; resolution: string; requiresBuild: boolean; deps: string[] }
  const sections: Record<string, Entry[]> = { packages: [], snapshots: [] }
  let section = '', cur: Entry | null = null, sub = ''
  let links = 0, linkLine = 0
  L.forEach((l, i) => {
    const top = l.match(/^(\w+):/)
    if (top) { section = top[1]; cur = null; sub = ''; return }
    if (section === 'packages' || section === 'snapshots') {
      const k = pnpmKey(l)
      if (k !== null) { cur = { key: k, line: at(i), platform: false, resolution: '', requiresBuild: false, deps: [] }; sections[section].push(cur); sub = ''; return }
      if (!cur) return
      if (/^ {4}\S/.test(l)) {
        const m = l.match(/^ {4}(\w+):(?: (.*))?$/)
        if (!m) return
        sub = m[1]
        if (/^(os|cpu|libc)$/.test(m[1])) cur.platform = true
        if (m[1] === 'resolution') cur.resolution = m[2] ?? ''
        if (m[1] === 'requiresBuild') cur.requiresBuild = m[2]?.trim() === 'true'
      } else if (/^ {6}\S/.test(l) && /^(dependencies|optionalDependencies)$/.test(sub)) {
        const m = l.match(/^ {6}('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s:]+):/)
        if (m) cur.deps.push(unquote(m[1]))
      }
      return
    }
    // Importers (or the root of a single-project v6 file): "version: link:../x" is a workspace link.
    if (/^\s+version:\s*['"]?link:/.test(l)) { if (!links++) linkLine = at(i) }
  })

  // v9 keeps dependencies in snapshots, keyed by the package id plus peer suffixes.
  const hinted = new Set<string>()
  for (const s of sections.snapshots) if (s.deps.some(d => NATIVE_HINT.test(d))) hinted.add(s.key.replace(/\(.*$/, ''))

  const scan = newScan()
  scan.local = { count: links, line: linkLine }
  for (const e of sections.packages) {
    let key = e.key.replace(/\(.*$/, '')
    if (v6) {
      // v6 ids start with "/"; ids without it name another registry or a git host (host/user/repo/sha).
      if (!key.startsWith('/')) { scan.remote.push({ name: key, spec: key, line: e.line }); continue }
      key = key.slice(1)
    }
    const { name, range: ver } = splitSpec(key)
    if (/^(file|link):/.test(ver) || /type:\s*directory/.test(e.resolution)) { addLocal(scan, e.line); continue }
    if (!SEMVER.test(ver) || /type:\s*(git|binary)|gitHosted/.test(e.resolution)) { scan.remote.push({ name, spec: ver, line: e.line }); continue }
    if (e.platform) continue // os/cpu/libc-specific packages (fsevents, @esbuild/*) are picked per platform.
    // Only pnpm 8 (6.x) writes requiresBuild, and only when true. Its absence is not proof of "no install script".
    scan.pkgs.push({ name, version: ver, line: e.line, installScript: e.requiresBuild, hint: hinted.has(key) || e.deps.some(d => NATIVE_HINT.test(d)) })
  }
  return [...issues, ...finishNodeLock(c, scan, 'pnpm-lock.yaml')]
}

// ---------- Whole-repo analysis ----------

const GROUP_DIRS = /^(services|apps|cmd|packages|src|svc|components|deploy|deployments?|docker|dockerfiles|main|java|build|k8s|kubernetes|manifests|helm|charts?|ci|release)$/i

/** The service a file belongs to: its nearest meaningful directory. */
export function serviceOf(path: string): string {
  const dirs = path.split('/').slice(0, -1).filter(d => d && d !== '.')
  const meaningful = dirs.filter(d => !GROUP_DIRS.test(d))
  return (meaningful[meaningful.length - 1] ?? dirs[dirs.length - 1] ?? 'root').toLowerCase()
}

export function analyze(files: RepoFile[]): Analysis {
  const findings: Finding[] = []
  const reports: FileReport[] = []
  const services = new Map<string, Service>()
  const svc = (name: string, file: string) => {
    const s = services.get(name) ?? { name, files: [] }
    if (!s.files.includes(file)) s.files.push(file)
    services.set(name, s)
    return s
  }
  const kinds = files.map(f => ({ f, kind: detectKind(f.path, f.text) }))
  // Dockerfiles first so lockfiles know the libc, and deploy files know which images are built here.
  const libcByService = new Map<string, 'glibc' | 'musl'>()
  const builtHere = new Set<string>()
  // A lockfile below a Dockerfile's directory (api/app/requirements.txt under api/Dockerfile) belongs to that service.
  const dockerDirs = new Map<string, string>()
  const dirOf = (p: string) => p.split('/').slice(0, -1).join('/')
  for (const { f, kind } of kinds) if (kind === 'dockerfile' && dirOf(f.path) && !dockerDirs.has(dirOf(f.path))) dockerDirs.set(dirOf(f.path), serviceOf(f.path))
  const owner = (path: string) => {
    for (let d = dirOf(path); d; d = dirOf(d)) if (dockerDirs.has(d)) return dockerDirs.get(d)!
    return serviceOf(path)
  }
  const order: FileKind[] = ['dockerfile', 'requirements', 'poetry', 'package-lock', 'yarn-lock', 'pnpm-lock', 'go-mod', 'pom', 'gradle', 'cargo', 'compose', 'k8s']
  for (const kind of order) {
    for (const { f } of kinds.filter(k => k.kind === kind)) {
      const lines = f.text.split('\n').length
      const before = findings.length
      let issues: FileIssue[] = []
      const service = kind === 'dockerfile' ? serviceOf(f.path) : owner(f.path)
      const c: Ctx = { file: f.path, service, out: findings }
      if (kind === 'dockerfile') {
        const info = parseDockerfile(c, f.text)
        issues = info.issues
        libcByService.set(service, info.libc)
        builtHere.add(service)
        const s = svc(service, f.path)
        s.dockerfile = f.path
        s.language = s.language ?? info.language
      } else if (kind === 'compose') {
        const r = parseCompose(f.path, f.text, findings, builtHere)
        issues = r.issues
        r.services.forEach(n => svc(n.toLowerCase(), f.path))
      } else if (kind === 'k8s') {
        const r = parseK8s(f.path, f.text, findings, builtHere)
        issues = r.issues
        r.workloads.forEach(n => svc(n.toLowerCase(), f.path))
      } else {
        const libc = libcByService.get(service) ?? 'glibc'
        issues = kind === 'requirements' ? parseRequirements(c, f.text, libc)
          : kind === 'poetry' ? parsePoetry(c, f.text, libc)
          : kind === 'package-lock' ? parsePackageLock(c, f.text)
          : kind === 'yarn-lock' ? parseYarnLock(c, f.text)
          : kind === 'pnpm-lock' ? parsePnpmLock(c, f.text)
          : kind === 'go-mod' ? parseGoMod(c, f.text)
          : kind === 'pom' ? parsePom(c, f.text)
          : kind === 'gradle' ? parseGradle(c, f.text)
          : parseCargo(c, f.text)
        const s = svc(service, f.path)
        s.language = s.language ?? ({ requirements: 'Python', poetry: 'Python', 'package-lock': 'Node.js', 'yarn-lock': 'Node.js', 'pnpm-lock': 'Node.js', 'go-mod': 'Go', pom: 'Java', gradle: 'Java', cargo: 'Rust' } as Record<string, string>)[kind]
      }
      // Findings from compose/k8s carry their own service names.
      for (const fd of findings.slice(before)) fd.service = fd.service.toLowerCase()
      reports.push({ path: f.path, kind, lines, items: findings.length - before, issues })
    }
  }
  for (const { f, kind } of kinds) {
    if (order.includes(kind)) continue
    reports.push({ path: f.path, kind, lines: f.text.split('\n').length, items: 0, issues: kind === 'unknown' ? [{ line: 1, level: 'warn', message: 'Format not recognised; this file was skipped.' }] : [] })
  }
  // Re-key ids after lower-casing service names, and attach finding-only services.
  for (const fd of findings) { fd.id = fd.id.replace(/^[^|]*/, fd.service); svc(fd.service, fd.file) }
  return { services: [...services.values()].sort((a, b) => a.name.localeCompare(b.name)), findings, files: reports }
}
