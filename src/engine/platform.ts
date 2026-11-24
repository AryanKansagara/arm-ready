// Platform fields (os, cpu, libc) of lockfile entries, and what they mean for linux/arm64.
//
// Sources:
//   npm and pnpm: a value list is matched the way npm-install-checks does (lib/index.js, checkList):
//     any negated value ("!arm64") that equals the current value rejects it, otherwise it needs one of the
//     non-negated values, and a list of only negated values accepts everything else. ["any"] accepts everything.
//     pnpm applies the same rule to packages[id].os / cpu / libc (pnpm/spec lockfile/9.0.md).
//   Yarn Berry: `conditions: os=linux & cpu=x64 & libc=glibc` is written by Manifest.getConditions() in
//     yarnpkg/berry packages/yarnpkg-core/sources/Manifest.ts: atoms `os|cpu|libc=value`, a leading "!" for a
//     negated value, "(a | b)" for several values, " & " between fields. Project.ts only disables a conditional
//     package that is reachable through optional dependencies alone.

/** (os, cpu, libc) -> does the package install there? */
export type PlatTest = (os: string, cpu: string, libc: string) => boolean

/** CPU names tried when asking "which CPUs does this package install on?". Node's process.arch values. */
const CPUS = ['x64', 'arm64', 'arm', 'ia32', 'ppc64', 'ppc', 's390x', 's390', 'riscv64', 'loong64', 'mips64el', 'mipsel', 'mips']
export const LIBCS = ['glibc', 'musl'] as const
export type Libc = (typeof LIBCS)[number]

export function listAllows(value: string, list: readonly string[]): boolean {
  if (list.length === 1 && list[0] === 'any') return true
  let negated = 0, match = false
  for (const entry of list) {
    if (entry.startsWith('!')) { negated++; if (entry.slice(1) === value) return false }
    else if (entry === value) match = true
  }
  return match || negated === list.length
}

export interface PlatLists { os?: string[]; cpu?: string[]; libc?: string[] }

/** A package restricted by os / cpu / libc lists. A missing list allows everything. */
export function testFromLists(l: PlatLists): PlatTest {
  return (os, cpu, libc) => (!l.os || listAllows(os, l.os)) && (!l.cpu || listAllows(cpu, l.cpu)) && (!l.libc || listAllows(libc, l.libc))
}

/** Readable form of the restriction, as the lockfile wrote it. */
export function describeLists(l: PlatLists): string {
  return (['os', 'cpu', 'libc'] as const).filter(k => l[k]).map(k => `${k}: ${l[k]!.join(', ')}`).join('; ')
}

/** JSON value of a platform field: an array of strings, or a single string. null when it is neither. */
export function jsonList(v: unknown): string[] | null | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'string') return [v]
  if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v as string[]
  return null
}

/** A pnpm value: `[x64, arm64]`, a bare `x64`, or `[]`. null when it is something else. */
export function flowList(raw: string): string[] | null {
  const t = raw.trim()
  const strip = (s: string) => { const x = s.trim(); return (x.startsWith("'") && x.endsWith("'") && x.length > 1) || (x.startsWith('"') && x.endsWith('"') && x.length > 1) ? x.slice(1, -1) : x }
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) return null
    const inner = t.slice(1, -1).trim()
    return inner ? inner.split(',').map(strip).filter(Boolean) : []
  }
  if (!t || /[\[\]{}]/.test(t)) return null
  return [strip(t)]
}

/** A Yarn Berry `conditions` value as a test, or null when it cannot be parsed. */
export function testFromConditions(raw: string): PlatTest | null {
  const tokens = raw.match(/\(|\)|&|\||!|(?:os|cpu|libc)=[A-Za-z0-9_-]+|\S/g) ?? []
  let pos = 0
  type Node = PlatTest
  const peek = () => tokens[pos]
  const atom = (): Node | null => {
    const t = tokens[pos++]
    if (t === undefined) return null
    if (t === '!') { const inner = atom(); return inner && ((o, c, l) => !inner(o, c, l)) }
    if (t === '(') {
      const inner = or()
      if (!inner || tokens[pos++] !== ')') return null
      return inner
    }
    const m = t.match(/^(os|cpu|libc)=(.+)$/)
    if (!m) return null
    const [, field, value] = m
    return (o, c, l) => (field === 'os' ? o : field === 'cpu' ? c : l) === value
  }
  const and = (): Node | null => {
    let left = atom()
    while (left && peek() === '&') { pos++; const right = atom(); if (!right) return null; const a = left; left = (o, c, l) => a(o, c, l) && right(o, c, l) }
    return left
  }
  function or(): Node | null {
    let left = and()
    while (left && peek() === '|') { pos++; const right = and(); if (!right) return null; const a = left; left = (o, c, l) => a(o, c, l) || right(o, c, l) }
    return left
  }
  const t = or()
  return t && pos === tokens.length ? t : null
}

export interface LinuxSupport {
  /** libc flavours (of the target) on which the package installs on Linux for some CPU. Empty: it does not apply to Linux. */
  applies: Libc[]
  /** Of those, the ones where it does NOT install on linux/arm64. */
  noArm: Libc[]
  /** CPUs it installs on, on Linux. */
  cpus: string[]
}

/** `libc` is the target image's libc, or undefined when no Dockerfile says (then both are considered). */
export function linuxSupport(test: PlatTest, libc?: Libc): LinuxSupport {
  const targets: readonly Libc[] = libc ? [libc] : LIBCS
  const applies = targets.filter(l => CPUS.some(c => test('linux', c, l)))
  return { applies, noArm: applies.filter(l => !test('linux', 'arm64', l)), cpus: CPUS.filter(c => applies.some(l => test('linux', c, l))) }
}

/** True when the package installs on linux/arm64 for this libc. */
export const armOn = (test: PlatTest, libc: Libc) => test('linux', 'arm64', libc)

/** Names the arm64 build of an x64 package is likely to have: vendor-linux-x64 -> vendor-linux-arm64. */
export function armTwins(name: string): string[] {
  const re = /x86[-_]64|x64|amd64/g
  if (!re.test(name)) return []
  return ['arm64', 'aarch64'].map(arm => name.replace(/x86[-_]64|x64|amd64/g, arm))
}
