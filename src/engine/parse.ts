import { CARGO, GO, JAVA, NPM, OS_PACKAGES } from './knowledge.ts'
import type { Analysis, Ecosystem, FileIssue, FileKind, FileReport, Finding, RepoFile, Service } from './types.ts'

// ---------- Format detection ----------

export function detectKind(path: string, text: string): FileKind {
  const base = path.split('/').pop()!.toLowerCase()
  if (/^(dockerfile|containerfile)(\..+)?$/.test(base) || base.endsWith('.dockerfile')) return 'dockerfile'
  if (/^(docker-)?compose[\w.-]*\.ya?ml$/.test(base)) return 'compose'
  if (base === 'poetry.lock') return 'poetry'
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return 'package-lock'
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
  if (/^[A-Za-z0-9_.-]+\s*(==|>=|~=)/m.test(t)) return 'requirements'
  return 'unknown'
}

export const KIND_LABEL: Record<FileKind, string> = {
  dockerfile: 'Dockerfile', compose: 'Docker Compose', k8s: 'Kubernetes manifest', requirements: 'requirements.txt', poetry: 'poetry.lock',
  'package-lock': 'package-lock.json', 'go-mod': 'go.mod', pom: 'pom.xml', gradle: 'Gradle dependencies', cargo: 'Cargo.lock',
  inventory: 'Instance inventory', manifests: 'docker manifest inspect export', unknown: 'Not recognised',
}

// ---------- Image references ----------

export interface ImageRef { registry: string; repo: string; tag: string; digest?: string; canonical: string }

export function parseImageRef(raw: string): ImageRef | null {
  let s = raw.trim().replace(/^["']|["']$/g, '')
  if (!s || /\$/.test(s) || /\s/.test(s)) return null
  let digest: string | undefined
  const at = s.indexOf('@')
  if (at >= 0) { digest = s.slice(at + 1); s = s.slice(0, at) }
  let tag = 'latest'
  const slash = s.lastIndexOf('/')
  const colon = s.lastIndexOf(':')
  if (colon > slash) { tag = s.slice(colon + 1); s = s.slice(0, colon) }
  const parts = s.split('/')
  let registry = 'docker.io'
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) registry = parts.shift()!
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io'
  let repo = parts.join('/').toLowerCase()
  if (!repo || !/^[a-z0-9._/-]+$/.test(repo)) return null
  if (registry === 'docker.io' && !repo.includes('/')) repo = 'library/' + repo
  const short = registry === 'docker.io' ? repo.replace(/^library\//, '') : `${registry}/${repo}`
  return { registry, repo, tag, digest, canonical: `${short}${digest ? '@' + digest : ':' + tag}` }
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
  add(c, { ecosystem: 'image', name: ref.canonical, line, status: 'pending', lookup: 'image', role, libc, title: 'Checking registry for linux/arm64', detail: '', effort: 'S' })
}

// ---------- Dockerfile ----------

export interface DockerStage { image: string; alias?: string; platform?: string; line: number; internal: boolean }
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

export function substitute(s: string, vars: Record<string, string>): string {
  return s.replace(/\$\{(\w+)(?::?[-=]([^}]*))?\}|\$(\w+)/g, (all, a, def, b) => {
    const k = a ?? b
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
        if (name && !(name in vars)) vars[name] = v.join('=').replace(/^["']|["']$/g, '')
      }
    } else if (op === 'FROM') {
      const m = substitute(args, vars).match(/^(?:--platform=(\S+)\s+)?(\S+)(?:\s+as\s+(\S+))?/i)
      if (!m) { issues.push({ line, level: 'error', message: 'Could not read this FROM line.' }); continue }
      const [, platform, image, alias] = m
      const internal = stages.some(s => s.alias?.toLowerCase() === image.toLowerCase()) || image === 'scratch'
      const isFinal = k === finalIdx
      stages.push({ image, alias, platform, line, internal })
      if (/alpine/i.test(image)) libc = 'musl'
      if (isFinal) {
        libc = /alpine/i.test(image) ? 'musl' : 'glibc'
        language = langOf(image) ?? language
      } else language = language ?? langOf(image)
      if (platform && /amd64|x86_64/.test(platform)) {
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
    if (img) pendingImage.push({ image: img[1], line: i + 1 })
    if (/^\s*build:/.test(l)) hasBuild = true
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
      else if (name.endsWith('-sys')) add(c, { ecosystem: 'cargo', name, version: v[1], line, status: 'warn', title: 'Links a C library', detail: '*-sys crates compile or link native code; cross builds need the aarch64 headers.', fix: 'Build on an arm64 runner, or install the target dev package.', effort: 'S' })
      name = ''
    }
  })
  if (!n) return [{ line: 1, level: 'error', message: 'No [[package]] entries found.' }]
  add(c, { ecosystem: 'cargo', name: `${n} crates`, key: 'rust', line: 1, status: 'ok', title: 'Rust targets aarch64-unknown-linux-gnu', detail: 'Tier 1 target; pure-Rust crates need no changes.', effort: 'S' })
  return []
}

// ---------- Whole-repo analysis ----------

const GROUP_DIRS = /^(services|apps|cmd|packages|src|svc|components|deploy|docker)$/i

/** The service a file belongs to: its nearest meaningful directory. */
export function serviceOf(path: string): string {
  const dirs = path.split('/').slice(0, -1).filter(d => d && d !== '.')
  const meaningful = dirs.filter(d => !GROUP_DIRS.test(d))
  return (meaningful[0] ?? dirs[dirs.length - 1] ?? 'root').toLowerCase()
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
  const order: FileKind[] = ['dockerfile', 'requirements', 'poetry', 'package-lock', 'go-mod', 'pom', 'gradle', 'cargo', 'compose', 'k8s']
  for (const kind of order) {
    for (const { f } of kinds.filter(k => k.kind === kind)) {
      const lines = f.text.split('\n').length
      const before = findings.length
      let issues: FileIssue[] = []
      const service = serviceOf(f.path)
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
          : kind === 'go-mod' ? parseGoMod(c, f.text)
          : kind === 'pom' ? parsePom(c, f.text)
          : kind === 'gradle' ? parseGradle(c, f.text)
          : parseCargo(c, f.text)
        const s = svc(service, f.path)
        s.language = s.language ?? ({ requirements: 'Python', poetry: 'Python', 'package-lock': 'Node.js', 'go-mod': 'Go', pom: 'Java', gradle: 'Java', cargo: 'Rust' } as Record<string, string>)[kind]
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
