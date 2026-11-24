// Platform-restricted lockfile entries (os, cpu, libc) and unreadable lockfiles.
//
// Fixtures in ./fixtures are excerpts of real public lockfiles; entries keep their original text. Sources (raw file at the named commit):
//
//   package-lock.esbuild-rolldown.playwright.json  microsoft/playwright (Apache-2.0)  package-lock.json @ 8c84d7786fab1cee5d41c9cf205f6551f9eb39ae
//                                                  (root entry, esbuild + @esbuild/*, rolldown + @rolldown/binding-*, fsevents; JSON re-indented by 2 as npm writes it)
//   yarn-berry-v8.esbuild-family.lock              yarnpkg/berry (BSD-2-Clause)         yarn.lock @ c6764b28f8e8dbdac7ad318d6d98b5d5f0f4679e (esbuild 0.15.11 and its platform packages, named esbuild-linux-64 and so on)
//   yarn-berry-v10.codex-alias.storybook.lock      storybookjs/storybook (MIT)          yarn.lock @ a5043fb99fb5e29a94f4282269270a4469d08812 (@openai/codex platform builds installed under aliases)
//   pnpm-v9.esbuild-rollup-family.vite.yaml        vitejs/vite (MIT)                    pnpm-lock.yaml @ 942f6d73df1c990865550bf4fafae3b8893b0f66 (project document; importers cut to an empty root)
//   pnpm-v9.direct-platform-deps.tailwindcss.yaml  tailwindlabs/tailwindcss (MIT)       pnpm-lock.yaml @ d5809986276509ae94e9dccb09e83b3367912053 (a package that lists every platform build as its own dependency)
//
// How the platform fields are read: npm-install-checks lib/index.js (checkPlatform, checkList) for npm and pnpm, and
// yarnpkg/berry packages/yarnpkg-core/sources/Manifest.ts (getConditions) for Yarn Berry. See platform.ts.
// Tests marked "synthetic" build a tiny file from the documented layout, or edit a real one, because no real file shows the case.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { scoreServices } from './classify.ts'
import { analyze, parsePackageLock } from './parse.ts'
import { armTwins, flowList, linuxSupport, listAllows, testFromConditions, testFromLists } from './platform.ts'
import { SAMPLE_FILES } from './sample.ts'
import type { Finding } from './types.ts'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const NPM = fx('package-lock.esbuild-rolldown.playwright.json')
const BERRY_ESBUILD = fx('yarn-berry-v8.esbuild-family.lock')
const BERRY_CODEX = fx('yarn-berry-v10.codex-alias.storybook.lock')
const PNPM_VITE = fx('pnpm-v9.esbuild-rollup-family.vite.yaml')
const PNPM_DIRECT = fx('pnpm-v9.direct-platform-deps.tailwindcss.yaml')

const run = (path: string, text: string, extra: { path: string; text: string }[] = []) => analyze([{ path: `api/${path}`, text }, ...extra])
const npm = (text: string) => run('package-lock.json', text)
const yarn = (text: string) => run('yarn.lock', text)
const pnpm = (text: string) => run('pnpm-lock.yaml', text)
const platform = (a: { findings: Finding[] }) => a.findings.filter(f => f.id.includes('|npm|platform|'))
const unreadable = (a: { findings: Finding[] }) => a.findings.filter(f => f.title === 'Lockfile could not be read')
const issues = (a: ReturnType<typeof analyze>) => a.files[0].issues
/** The service state once the live npm lookups (still pending here) have all come back clean. */
const state = (a: ReturnType<typeof analyze>) => scoreServices(a.services.map(s => s.name), a.findings.filter(f => f.status !== 'pending'))[0].state
/** 1-based line of the first line that starts with `prefix`. */
const lineOf = (text: string, prefix: string) => text.split('\n').findIndex(l => l.startsWith(prefix)) + 1
const lines = (text: string) => text.split('\n')

/** Removes every entry whose key line starts with `key` (pnpm: a 2-space key, and its 4-space fields up to the blank line). */
const dropPnpm = (text: string, key: string) => text.replace(new RegExp(`^  '?${key.replace(/[/@.()]/g, '\\$&')}'?:.*\n(?:    .*\n)*\n?`, 'gm'), '')

/** The playwright excerpt as an object, edited, and written back the way npm writes it. */
function editNpm(edit: (packages: Record<string, Record<string, unknown>>) => void) {
  const j = JSON.parse(NPM) as { packages: Record<string, Record<string, unknown>> }
  edit(j.packages)
  return JSON.stringify(j, null, 2) + '\n'
}

test('platform lists follow npm-install-checks: negation, several values, any', () => {
  assert.ok(listAllows('x64', ['x64']))
  assert.ok(!listAllows('arm64', ['x64']))
  assert.ok(listAllows('arm64', ['x64', 'arm64']))
  // only negated values: everything else is allowed
  assert.ok(!listAllows('arm64', ['!arm64']))
  assert.ok(listAllows('x64', ['!arm64']))
  assert.ok(listAllows('arm64', ['!ia32', '!x64']))
  assert.ok(!listAllows('x64', ['!ia32', '!x64']))
  // a non-negated value must match, and a negated value always rejects
  assert.ok(!listAllows('arm64', ['x64', '!ia32']))
  assert.ok(!listAllows('x64', ['x64', '!x64']))
  assert.ok(listAllows('arm64', ['any']))
  assert.ok(listAllows('arm64', []))

  const t = testFromLists({ os: ['linux'], cpu: ['x64'], libc: ['glibc'] })
  assert.ok(t('linux', 'x64', 'glibc'))
  assert.ok(!t('linux', 'x64', 'musl') && !t('linux', 'arm64', 'glibc') && !t('darwin', 'x64', 'glibc'))
  assert.deepEqual(flowList('[x64, arm64]'), ['x64', 'arm64'])
  assert.deepEqual(flowList("['!arm64']"), ['!arm64'])
  assert.deepEqual(flowList('x64'), ['x64'])
  assert.deepEqual(flowList('[]'), [])
  assert.equal(flowList('{a: b}'), null)
  assert.equal(flowList('[x64'), null)
})

test('Yarn Berry conditions: Manifest.getConditions syntax', () => {
  const t = testFromConditions('os=linux & cpu=x64')!
  assert.ok(t('linux', 'x64', 'glibc') && !t('linux', 'arm64', 'glibc') && !t('darwin', 'x64', 'glibc'))
  const multi = testFromConditions('(os=linux | os=darwin) & (cpu=x64 | cpu=arm64) & libc=musl')!
  assert.ok(multi('darwin', 'arm64', 'musl') && !multi('darwin', 'arm64', 'glibc') && !multi('win32', 'x64', 'musl'))
  // "!" negates one value: values "!arm64" and "!!arm64" are written as "!cpu=arm64" and "cpu=arm64"
  const neg = testFromConditions('!cpu=arm64')!
  assert.ok(neg('linux', 'x64', 'glibc') && !neg('linux', 'arm64', 'glibc'))
  for (const bad of ['', 'os=linux &', 'os=linux cpu=x64', '(os=linux', 'cpu=', 'platform=x', 'os=linux | | cpu=x64', ')']) assert.equal(testFromConditions(bad), null, bad)
})

test('linuxSupport: which CPUs, which libc, and whether arm64 is among them', () => {
  const x64 = linuxSupport(testFromLists({ os: ['linux'], cpu: ['x64'] }))
  assert.deepEqual(x64.applies, ['glibc', 'musl'])
  assert.deepEqual(x64.noArm, ['glibc', 'musl'])
  assert.deepEqual(x64.cpus, ['x64'])
  assert.deepEqual(linuxSupport(testFromLists({ os: ['darwin'], cpu: ['x64'] })).applies, [])
  assert.deepEqual(linuxSupport(testFromLists({ os: ['linux'], cpu: ['x64', 'arm64'] })).noArm, [])
  assert.deepEqual(linuxSupport(testFromLists({ os: ['!linux'] })).applies, [])
  // a glibc-only package does not apply to a musl image, and the other way round
  const gnu = testFromLists({ os: ['linux'], cpu: ['x64'], libc: ['glibc'] })
  assert.deepEqual(linuxSupport(gnu, 'musl').applies, [])
  assert.deepEqual(linuxSupport(gnu, 'glibc').noArm, ['glibc'])
  assert.deepEqual(linuxSupport(gnu).applies, ['glibc'])
  assert.deepEqual(armTwins('@esbuild/linux-x64'), ['@esbuild/linux-arm64', '@esbuild/linux-aarch64'])
  assert.deepEqual(armTwins('lightningcss-linux-x64-gnu')[0], 'lightningcss-linux-arm64-gnu')
  assert.deepEqual(armTwins('sharp'), [])
})

test('npm (playwright): esbuild, rolldown and fsevents families add nothing', () => {
  const a = npm(NPM)
  assert.deepEqual(issues(a).filter(i => i.level !== 'info'), [])
  assert.equal(platform(a).length, 0)
  assert.equal(unreadable(a).length, 0)
  // esbuild is curated; the platform packages are neither looked up on npm nor counted as pure JavaScript.
  assert.equal(a.findings.find(f => f.name === 'esbuild')!.status, 'ok')
  assert.ok(!a.findings.some(f => /@esbuild|@rolldown\/binding|fsevents/.test(f.name)))
  assert.equal(state(a), 'ready')
})

test('npm: an arm64 variant missing from the lockfile is reported at its x64 sibling, with the right line and status', () => {
  // Real lockfile, edit: drop @esbuild/linux-arm64 (and the entry that would stand in for it).
  const text = editNpm(p => { delete p['node_modules/@esbuild/linux-arm64'] })
  const a = npm(text)
  const f = platform(a)
  // Every other Linux CPU only had linux-arm64 as its stand-in, so they are listed too.
  assert.deepEqual(f.map(x => x.name), ['@esbuild/linux-arm', '@esbuild/linux-ia32', '@esbuild/linux-loong64', '@esbuild/linux-mips64el', '@esbuild/linux-ppc64', '@esbuild/linux-riscv64', '@esbuild/linux-s390x', '@esbuild/linux-x64'])
  assert.ok(f.every(x => x.status === 'warn' && x.title === 'Optional package is skipped on arm64' && x.version === '0.28.1' && x.file === 'api/package-lock.json'))
  const x64 = f.find(x => x.name === '@esbuild/linux-x64')!
  assert.equal(x64.line, lineOf(text, '    "node_modules/@esbuild/linux-x64"'))
  const note = issues(a).find(i => /@esbuild\/linux-x64@0\.28\.1/.test(i.message))!
  assert.match(note.message, /is optional and supports only x64 on Linux/)
  assert.equal(note.level, 'warn')
  assert.equal(note.line, x64.line)
  assert.equal(state(a), 'needs-work')
  // The win32 / darwin / freebsd builds are not Linux: still nothing.
  assert.ok(!platform(a).some(x => /darwin|win32|freebsd/.test(x.name)))
})

test('npm: required, dev-only, optional and unrecorded x64 packages are told apart (synthetic edits of the real file)', () => {
  const lock = (entry: Record<string, unknown>, parent: Record<string, unknown> | null = null) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' }, ...(parent ? { 'node_modules/parent': parent } : {}), 'node_modules/vendor-x64': { version: '1.0.0', cpu: ['x64'], os: ['linux'], ...entry } } }, null, 2)
  const required = npm(lock({}))
  assert.equal(platform(required)[0].status, 'block')
  assert.equal(platform(required)[0].title, 'Required package has no linux/arm64 build')
  assert.equal(state(required), 'blocked')
  assert.equal(platform(npm(lock({ dev: true })))[0].status, 'warn')
  assert.equal(platform(npm(lock({ dev: true })))[0].title, 'Dev dependency has no linux/arm64 build')
  assert.equal(platform(npm(lock({ optional: true })))[0].status, 'warn')
  // optional because a parent lists it under optionalDependencies, even without the flag
  const viaParent = npm(lock({}, { version: '1.0.0', optionalDependencies: { 'vendor-x64': '1.0.0' } }))
  assert.equal(platform(viaParent)[0].status, 'warn')
  assert.equal(platform(viaParent)[0].title, 'Optional package is skipped on arm64')
  // an arm64 build next to it in the same parent: fine, whether or not the flag is there
  const family = npm(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/parent': { version: '1.0.0', optionalDependencies: { 'vendor-x64': '1.0.0', 'vendor-arm': '1.0.0' } }, 'node_modules/vendor-x64': { version: '1.0.0', cpu: ['x64'], os: ['linux'] }, 'node_modules/vendor-arm': { version: '1.0.0', cpu: ['arm64'], os: ['linux'] } } }))
  assert.equal(platform(family).length, 0)
  // and one with a different OS is not a stand-in
  const wrongOs = npm(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/parent': { version: '1.0.0', optionalDependencies: { 'vendor-x64': '1.0.0', 'vendor-mac': '1.0.0' } }, 'node_modules/vendor-x64': { version: '1.0.0', cpu: ['x64'], os: ['linux'] }, 'node_modules/vendor-mac': { version: '1.0.0', cpu: ['arm64'], os: ['darwin'] } } }))
  assert.equal(platform(wrongOs)[0].name, 'vendor-x64')
})

test('npm: negated, multi-value and unreadable platform fields (synthetic)', () => {
  const one = (fields: Record<string, unknown>) => platform(npm(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/v': { version: '1.0.0', ...fields } } }, null, 2))) // line 5 is the entry
  assert.equal(one({ cpu: ['!arm64'] })[0]?.status, 'block')
  assert.match(one({ cpu: ['!arm64'] })[0].detail, /every CPU except arm64/)
  assert.deepEqual(one({ cpu: ['!ia32'] }), [])
  assert.deepEqual(one({ cpu: ['x64', 'arm64'] }), [])
  assert.deepEqual(one({ cpu: ['any'] }), [])
  assert.deepEqual(one({ cpu: [] }), [])
  assert.deepEqual(one({ cpu: 'arm64' }), [])
  assert.equal(one({ cpu: 'x64' })[0]?.status, 'block')
  assert.equal(one({ cpu: ['arm'], os: ['linux'] })[0]?.status, 'block') // 32-bit arm is not arm64
  assert.equal(one({ cpu: ['x64'], os: ['!win32'] })[0]?.status, 'block')
  assert.deepEqual(one({ cpu: ['x64'], os: ['!linux'] }), [])
  assert.deepEqual(one({ cpu: ['x64'], os: ['win32', 'darwin'] }), [])
  assert.deepEqual(one({ cpu: ['x64'], os: ['darwin', 'linux'] }).map(f => f.status), ['block'])
  // libc: a musl-only package does not matter to a glibc image (and the reverse); with no Dockerfile both are considered
  const musl = { cpu: ['x64'], os: ['linux'], libc: ['musl'] }
  assert.equal(one(musl)[0]?.status, 'block')
  assert.match(one(musl)[0].detail, /on musl Linux/)
  assert.deepEqual(one({ libc: ['glibc'] }), [])
  // unreadable fields are an unknown, never skipped and never a success
  for (const bad of [{ cpu: 7 }, { cpu: [1] }, { os: { a: 1 } }, { libc: null }]) {
    const f = one(bad)
    assert.equal(f.length, 1, JSON.stringify(bad))
    assert.equal(f[0].status, 'unknown')
    assert.equal(f[0].title, 'Platform restriction could not be read')
    assert.equal(f[0].line, 5)
  }
})

test('npm: the target libc comes from the service Dockerfile', () => {
  // synthetic: sharp-style glibc and musl builds, with an arm64 build only for glibc
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/img': { version: '1.0.0', optionalDependencies: { 'img-gnu-x64': '1.0.0', 'img-gnu-arm64': '1.0.0', 'img-musl-x64': '1.0.0' } },
    'node_modules/img-gnu-x64': { version: '1.0.0', cpu: ['x64'], os: ['linux'], libc: ['glibc'], optional: true },
    'node_modules/img-gnu-arm64': { version: '1.0.0', cpu: ['arm64'], os: ['linux'], libc: ['glibc'], optional: true },
    'node_modules/img-musl-x64': { version: '1.0.0', cpu: ['x64'], os: ['linux'], libc: ['musl'], optional: true } } }, null, 2)
  const docker = (base: string) => [{ path: 'api/Dockerfile', text: `FROM ${base}\nCOPY . .\n` }]
  assert.deepEqual(platform(run('package-lock.json', lock, docker('node:22-bookworm-slim'))), []) // musl build is not used
  assert.deepEqual(platform(run('package-lock.json', lock, docker('node:22-alpine'))).map(f => f.name), ['img-musl-x64'])
  assert.deepEqual(platform(npm(lock)).map(f => f.name), ['img-musl-x64'], 'no Dockerfile: both libc are considered')
})

test('npm: a package-lock.json that is not one is an error and an unknown, and never throws (synthetic)', () => {
  for (const text of ['null', '[]', '"x"', '7', '{}', '{"packages":[]}', '{"packages":"x"}', '{"packages":{"":{},"node_modules/a":null}}', '{"packages":{"":{},"node_modules/a":"1.0.0"}}', '{"packages":{"":{},"node_modules/a":[]}}', '{"lockfileVersion":1,"dependencies":{}}', '{"lockfileVersion": 3,\n "packages": {']) {
    const a = npm(text)
    assert.equal(issues(a)[0].level, 'error', text)
    assert.equal(unreadable(a).length, 1, text)
    assert.equal(state(a), 'needs-work', text)
  }
  // Merge conflict markers inside a JSON file: the line, not a JSON syntax error.
  const conflict = npm('{\n  "lockfileVersion": 3,\n<<<<<<< HEAD\n  "packages": {}\n=======\n  "packages": {"": {}}\n>>>>>>> branch\n}\n')
  assert.match(issues(conflict)[0].message, /merge conflict markers at line 3/i)
  assert.equal(issues(conflict)[0].line, 3)
  assert.equal(unreadable(conflict)[0].line, 3)
})

test('npm: a lockfile with no dependencies is valid and ready (synthetic)', () => {
  for (const text of ['{"lockfileVersion":3,"packages":{}}', '{"name":"x","lockfileVersion":3,"requires":true,"packages":{"":{"name":"x"}}}']) {
    const a = npm(text)
    assert.deepEqual(issues(a).map(i => i.level), ['info'])
    assert.equal(a.findings.length, 0)
    assert.equal(state(a), 'ready')
  }
})

test('npm: finding lines are the line of the package key, even when the path is named earlier (synthetic)', () => {
  const text = JSON.stringify({ lockfileVersion: 3, packages: { '': { workspaces: ['packages/a', 'packages/b'] }, 'packages/a': { version: '1.0.0', hasInstallScript: true }, 'packages/b': { version: '1.0.0', hasInstallScript: true }, 'node_modules/x': { version: '1.0.0', cpu: ['x64'] } } }, null, 2)
  const a = npm(text)
  assert.deepEqual(a.findings.filter(f => f.name.startsWith('packages/')).map(f => [f.name, f.line]), [['packages/a', lineOf(text, '    "packages/a"')], ['packages/b', lineOf(text, '    "packages/b"')]])
  assert.equal(platform(a)[0].line, lineOf(text, '    "node_modules/x"'))
  // a lockfile with thousands of entries is read in milliseconds, lines included
  const big = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0', hasInstallScript: i % 1000 === 0 }])) } }, null, 2)
  const t0 = Date.now()
  const b = parsePackageLock({ file: 'package-lock.json', service: 'x', out: [] }, big)
  assert.equal(b.length, 0)
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`)
})

test('pnpm 9 (vite): esbuild and rollup platform packages need no finding', () => {
  const a = pnpm(PNPM_VITE)
  assert.equal(platform(a).length, 0)
  assert.equal(unreadable(a).length, 0)
  assert.deepEqual(issues(a).filter(i => i.level !== 'info'), [])
  assert.equal(a.findings.find(f => f.name === 'esbuild')!.status, 'ok')
  assert.ok(!a.findings.some(f => /^@esbuild|^@rollup|^fsevents$/.test(f.name)))
  assert.equal(state(a), 'ready')
})

test('pnpm 9: a missing arm64 variant is reported from the snapshot flags (edits of the real file)', () => {
  // The arm64 build gone from packages and snapshots: the x64 build is optional (its snapshot says "optional: true") and skipped on arm64.
  const text = dropPnpm(PNPM_VITE, '@esbuild/linux-arm64@0.28.2')
  assert.ok(!text.includes('@esbuild/linux-arm64@0.28.2'), 'the edit removed both entries')
  const a = pnpm(text)
  const x64 = platform(a).find(f => f.name === '@esbuild/linux-x64')
  assert.equal(x64?.status, 'warn')
  assert.equal(x64?.title, 'Optional package is skipped on arm64')
  assert.equal(x64?.version, '0.28.2')
  assert.equal(x64?.line, lineOf(text, "  '@esbuild/linux-x64@0.28.2':"))
  assert.equal(state(a), 'needs-work')
  // The 32-bit arm, ia32 and other Linux builds only had linux-arm64 as their stand-in.
  assert.ok(platform(a).every(f => f.status === 'warn' && /^@esbuild\/linux-/.test(f.name)))
  // glibc and musl are told apart: without rollup's arm64-gnu build the x64-gnu one has no stand-in, the x64-musl one still has arm64-musl.
  const rollup = platform(pnpm(dropPnpm(PNPM_VITE, '@rollup/rollup-linux-arm64-gnu@4.64.9'))).map(f => f.name)
  assert.ok(rollup.includes('@rollup/rollup-linux-x64-gnu'))
  assert.ok(!rollup.includes('@rollup/rollup-linux-x64-musl') && !rollup.some(n => /arm64/.test(n)))
})

test('pnpm 9: required, optional and unrecorded (synthetic from the lockfile-format docs)', () => {
  const lock = (snapshot: string) => `lockfileVersion: '9.0'

importers:

  .: {}

packages:

  vendor-x64@1.0.0:
    resolution: {integrity: sha512-x}
    cpu: [x64]
    os: [linux]

${snapshot}`
  const required = pnpm(lock('snapshots:\n\n  vendor-x64@1.0.0: {}\n'))
  assert.equal(platform(required)[0].status, 'block')
  assert.equal(platform(required)[0].line, lineOf(lock(''), '  vendor-x64@1.0.0:'))
  assert.equal(state(required), 'blocked')
  assert.equal(platform(pnpm(lock('snapshots:\n\n  vendor-x64@1.0.0:\n    optional: true\n')))[0].status, 'warn')
  // no snapshots section: whether it is optional is not recorded
  const unknown = pnpm(lock(''))
  assert.equal(platform(unknown)[0].status, 'unknown')
  assert.equal(state(unknown), 'needs-work')
  // lists as a block, a bare scalar, negated, and unreadable
  const withCpu = (cpu: string) => pnpm(lock('snapshots:\n\n  vendor-x64@1.0.0: {}\n').replace('    cpu: [x64]\n', cpu))
  assert.equal(platform(withCpu('    cpu:\n      - x64\n'))[0].status, 'block')
  assert.equal(platform(withCpu('    cpu: x64\n'))[0].status, 'block')
  assert.equal(platform(withCpu("    cpu: ['!arm64']\n"))[0].status, 'block')
  assert.deepEqual(platform(withCpu('    cpu: [x64, arm64]\n')), [])
  assert.equal(platform(withCpu('    cpu: {a: b}\n'))[0].status, 'unknown')
  assert.equal(platform(withCpu('    cpu:\n'))[0].status, 'unknown')
  // pnpm 8 (6.x): optional and dev flags sit on the package
  const v6 = (flags: string) => pnpm(`lockfileVersion: '6.0'\n\npackages:\n\n  /vendor-x64@1.0.0:\n    resolution: {integrity: sha512-x}\n    cpu: [x64]\n    os: [linux]\n${flags}`)
  assert.equal(platform(v6('    dev: false\n'))[0].status, 'block')
  assert.equal(platform(v6('    dev: true\n'))[0].title, 'Dev dependency has no linux/arm64 build')
  assert.equal(platform(v6('    optional: true\n    dev: false\n'))[0].title, 'Optional package is skipped on arm64')
})

test('pnpm 9 (tailwindcss): platform builds listed as direct dependencies, each with its arm64 twin', () => {
  const a = pnpm(PNPM_DIRECT)
  assert.deepEqual(platform(a), [])
  assert.deepEqual(issues(a).filter(i => i.level !== 'info'), [])
  assert.equal(state(a), 'ready')
  // synthetic edit: without the arm64 twin of lightningcss-linux-x64-gnu, the x64 build is required (its snapshot has no "optional: true")
  const lost = dropPnpm(PNPM_DIRECT, 'lightningcss-linux-arm64-gnu@1.33.0')
  assert.ok(!/^  lightningcss-linux-arm64-gnu@/m.test(lost))
  const b = pnpm(lost)
  const x64 = platform(b).find(f => f.name === 'lightningcss-linux-x64-gnu')!
  assert.equal(x64.status, 'block')
  assert.equal(x64.line, lineOf(lost, '  lightningcss-linux-x64-gnu@1.33.0:'))
  // The libc is in the name here (the package declares none): the musl builds still have each other.
  assert.ok(!platform(b).some(f => /musl/.test(f.name)))
  assert.equal(state(b), 'blocked')
})

test('Yarn Berry v8 (berry): esbuild 0.15.11 platform packages, named esbuild-linux-64, are siblings through the parent', () => {
  const a = yarn(BERRY_ESBUILD)
  assert.equal(platform(a).length, 0)
  assert.equal(unreadable(a).length, 0)
  assert.equal(a.findings.find(f => f.name === 'esbuild')!.status, 'ok')
  assert.ok(!a.findings.some(f => /^esbuild-|^@esbuild/.test(f.name)))
  assert.equal(state(a), 'ready')
  // Edit: drop the linux-arm64 package. linux-64 (x64) is optional through dependenciesMeta and now has no arm64 stand-in.
  const lost = BERRY_ESBUILD.replace(/"esbuild-linux-arm64@npm:0\.15\.11":\n(?:  .*\n)+\n/, '')
  assert.notEqual(lost, BERRY_ESBUILD)
  const b = yarn(lost)
  const f = platform(b)
  // esbuild-linux-arm (32-bit) and the other Linux CPUs lose nothing, they only had linux-arm64 as their stand-in.
  assert.ok(f.length >= 2 && f.every(x => x.status === 'warn'), JSON.stringify(f.map(x => x.name)))
  const x64 = f.find(x => x.name === 'esbuild-linux-64')!
  assert.equal(x64.title, 'Optional package is skipped on arm64')
  assert.equal(x64.version, '0.15.11')
  assert.equal(x64.line, lineOf(lost, '"esbuild-linux-64@npm:0.15.11"'))
})

test('Yarn Berry v10 (storybook): platform builds installed under aliases are siblings through the alias names', () => {
  const a = yarn(BERRY_CODEX)
  assert.equal(platform(a).length, 0)
  assert.equal(state(a), 'ready')
  const lost = BERRY_CODEX.replace(/"@openai\/codex-linux-arm64@npm:[^\n]*\n(?:  .*\n)+\n/, '')
  assert.notEqual(lost, BERRY_CODEX)
  const f = platform(yarn(lost))
  assert.deepEqual(f.map(x => [x.name, x.version, x.status]), [['@openai/codex', '0.117.0-linux-x64', 'warn']])
  assert.equal(f[0].line, lineOf(lost, '"@openai/codex-linux-x64@npm:'))
})

test('Yarn Berry: required, optional and not recorded (synthetic from Manifest.ts and Project.ts)', () => {
  const lock = (root: string, conditions = 'os=linux & cpu=x64') => `__metadata:
  version: 8
  cacheKey: 10

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
${root}  languageName: unknown
  linkType: soft

"vendor-x64@npm:1.0.0":
  version: 1.0.0
  resolution: "vendor-x64@npm:1.0.0"
  conditions: ${conditions}
  languageName: node
  linkType: hard
`
  const deps = '  dependencies:\n    vendor-x64: "npm:1.0.0"\n'
  const required = yarn(lock(deps))
  assert.equal(platform(required)[0].status, 'block')
  assert.equal(platform(required)[0].line, lineOf(lock(deps), '"vendor-x64@npm:1.0.0"'))
  assert.equal(platform(yarn(lock(deps + '  dependenciesMeta:\n    vendor-x64:\n      optional: true\n')))[0].status, 'warn')
  // nothing depends on it: not recorded
  assert.equal(platform(yarn(lock('')))[0].status, 'unknown')
  // negation, several values and libc in the conditions
  assert.equal(platform(yarn(lock(deps, '"!cpu=arm64"')))[0].status, 'block')
  assert.deepEqual(platform(yarn(lock(deps, '(os=linux | os=darwin) & (cpu=x64 | cpu=arm64)'))), [])
  assert.equal(platform(yarn(lock(deps, '(os=linux | os=darwin) & (cpu=x64 | cpu=ia32)')))[0].status, 'block')
  assert.deepEqual(platform(yarn(lock(deps, 'os=linux & cpu=x64 & libc=musl'))).map(f => f.status), ['block'])
  assert.deepEqual(platform(yarn(lock(deps, 'os=darwin & cpu=x64'))), [])
  // conditions that cannot be parsed are an unknown with the line, not a skip
  const garbage = platform(yarn(lock(deps, 'os=linux &')))
  assert.deepEqual(garbage.map(f => [f.status, f.line]), [['unknown', lineOf(lock(deps), '"vendor-x64@npm:1.0.0"')]])
})

test('Yarn 1 does not record os and cpu: the platform families add nothing, and the file says why', () => {
  const text = '# yarn lockfile v1\n\n\n"@esbuild/linux-arm64@0.21.5":\n  version "0.21.5"\n  resolved "https://registry.yarnpkg.com/@esbuild/linux-arm64/-/linux-arm64-0.21.5.tgz#abc"\n\n"@esbuild/linux-x64@0.21.5":\n  version "0.21.5"\n  resolved "https://registry.yarnpkg.com/@esbuild/linux-x64/-/linux-x64-0.21.5.tgz#abc"\n\nesbuild@^0.21.3:\n  version "0.21.5"\n  resolved "https://registry.yarnpkg.com/esbuild/-/esbuild-0.21.5.tgz#abc"\n  optionalDependencies:\n    "@esbuild/linux-arm64" "0.21.5"\n    "@esbuild/linux-x64" "0.21.5"\n'
  const a = yarn(text)
  assert.equal(platform(a).length, 0)
  assert.equal(unreadable(a).length, 0)
  assert.ok(!a.findings.some(f => f.status === 'block' || f.status === 'unknown'))
  assert.ok(issues(a).some(i => i.level === 'info' && /Yarn 1 does not record os, cpu or libc/.test(i.message)))
})

test('every input from the issue table is something other than ready, except the genuinely empty lockfile (synthetic)', () => {
  const rows: Record<string, [string, string]> = {
    'package-lock, only x64': ['package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/vendor-x64': { version: '1.0.0', cpu: ['x64'], os: ['linux'] } } })],
    'pnpm 9, only x64': ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n\npackages:\n\n  vendor-x64@1.0.0:\n    resolution: {integrity: sha512-x}\n    cpu: [x64]\n    os: [linux]\n\nsnapshots:\n\n  vendor-x64@1.0.0: {}\n"],
    'pnpm, 4-space body': ['pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n    sharp@0.30.0:\n        resolution: {integrity: x}\n"],
    'pnpm, header only': ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n"],
    'yarn, merge conflict': ['yarn.lock', '# yarn lockfile v1\n\n<<<<<<< HEAD\nsharp@^0.30.0:\n  version "0.30.0"\n=======\n'],
    'yarn 1, tabs': ['yarn.lock', '# yarn lockfile v1\n\nsharp@^0.30.0:\n\tversion "0.30.0"\n'],
    'berry, only x64': ['yarn.lock', '__metadata:\n  version: 8\n  cacheKey: 10\n\n"vendor-x64@npm:1.0.0":\n  version: 1.0.0\n  resolution: "vendor-x64@npm:1.0.0"\n  conditions: os=linux & cpu=x64\n  languageName: node\n'],
  }
  for (const [name, [path, text]] of Object.entries(rows)) {
    const a = run(path, text)
    const [s] = scoreServices(a.services.map(x => x.name), a.findings)
    assert.notEqual(s.state, 'ready', name)
    assert.ok(s.score < 100, name)
    assert.ok(a.findings.some(f => f.status === 'block' || f.status === 'unknown'), name)
  }
  // and the unreadable ones are an error as well, on the right line
  assert.deepEqual(issues(pnpm(rows['pnpm, 4-space body'][1])).map(i => [i.level, i.line]), [['error', 3]])
  assert.deepEqual(issues(pnpm(rows['pnpm, header only'][1])).map(i => [i.level, i.line]), [['error', 1]])
  assert.deepEqual(issues(yarn(rows['yarn, merge conflict'][1])).map(i => [i.level, i.line]), [['error', 3]])
  assert.deepEqual(issues(yarn(rows['yarn 1, tabs'][1])).map(i => [i.level, i.line]), [['error', 4]])
  assert.equal(platform(npm(rows['package-lock, only x64'][1]))[0].line, 1) // one-line JSON: the entry is on line 1
  // The genuinely empty ones stay valid.
  const empty: [string, string][] = [
    ['package-lock.json', '{"lockfileVersion":3,"packages":{"":{}}}'],
    ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n"],
    ['pnpm-lock.yaml', "lockfileVersion: '6.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n"],
    ['yarn.lock', '# yarn lockfile v1\n\n\n'],
    ['yarn.lock', '__metadata:\n  version: 8\n  cacheKey: 10\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "app@workspace:."\n  languageName: unknown\n  linkType: soft\n'],
  ]
  for (const [path, text] of empty) {
    const a = run(path, text)
    assert.equal(state(a), 'ready', path + text)
    assert.ok(issues(a).every(i => i.level === 'info'), path)
  }
})

test('merge conflict markers in any of the three lockfiles: error on the first marker and an unknown (synthetic)', () => {
  const real = [['yarn.lock', fx('yarn-v1.react.lock')], ['yarn.lock', BERRY_CODEX], ['pnpm-lock.yaml', PNPM_DIRECT], ['package-lock.json', NPM]] as const
  for (const [path, text] of real) {
    const at = 8
    const split = lines(text)
    const broken = [...split.slice(0, at), '<<<<<<< HEAD', ...split.slice(at, at + 2), '=======', ...split.slice(at, at + 2), '>>>>>>> feature', ...split.slice(at + 2)].join('\n')
    const a = run(path, broken)
    assert.equal(issues(a)[0].level, 'error', path)
    assert.equal(issues(a)[0].line, at + 1, path)
    assert.match(issues(a)[0].message, /merge conflict markers at line 9/i)
    assert.equal(unreadable(a).length, 1, path)
    assert.equal(state(a), 'needs-work', path)
    // CRLF files too
    assert.equal(issues(run(path, broken.replace(/\n/g, '\r\n')))[0].line, at + 1, path)
  }
})

test('unreadable bodies: tabs, wrong indentation, entries without a version or resolution, truncated, never ready (real files edited)', () => {
  const REACT = fx('yarn-v1.react.lock')
  const cases: [string, ReturnType<typeof analyze>][] = [
    ['yarn 1, tab indent', yarn(REACT.replace(/^ {2}/gm, '\t'))],
    ['yarn 1, 4-space indent', yarn(REACT.replace(/^ {2}(\S)/gm, '    $1'))],
    ['yarn 1, 3-space indent', yarn(REACT.replace(/^ {2}version/m, '   version'))],
    ['yarn 1, version removed', yarn(REACT.replace(/^ {2}version .*\n/m, ''))],
    ['yarn 1, cut in a key', yarn(REACT.slice(0, REACT.indexOf('\n\n', 2000)) + '\n\nreact-dom@^')],
    ['yarn 1, a stray line', yarn(REACT.replace('\n\n"@babel', '\nnot a lockfile line\n\n"@babel'))],
    ['berry, tab indent', yarn(BERRY_CODEX.replace(/^ {2}/gm, '\t'))],
    ['berry, resolution removed', yarn(BERRY_CODEX.replace(/^ {2}resolution: .*\n/m, ''))],
    ['berry, no entries', yarn('__metadata:\n  version: 8\n  cacheKey: 10\n')],
    ['pnpm, tab indent', pnpm(PNPM_DIRECT.replace(/^ {4}resolution/gm, '\tresolution'))],
    ['pnpm, 4-space entries', pnpm(PNPM_DIRECT.replace(/^ {2}(\S.*:)$/gm, '    $1').replace(/^ {4}(\w+:)/gm, '        $1'))],
    ['pnpm, odd indent in a package', pnpm(PNPM_DIRECT.replace(/^ {4}resolution/m, '   resolution'))],
    ['pnpm, importers list packages that are missing', pnpm("lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      left-pad:\n        specifier: ^1.0.0\n        version: 1.3.0\n")],
    ['pnpm, header only', pnpm("lockfileVersion: '9.0'\n")],
  ]
  for (const [name, a] of cases) {
    assert.equal(issues(a)[0].level, 'error', name)
    assert.equal(unreadable(a).length, 1, name)
    assert.equal(state(a), 'needs-work', name)
    assert.ok(!a.findings.some(f => f.status === 'ok'), name)
  }
  // the unedited real files read without a problem
  for (const [path, text] of [['yarn.lock', REACT], ['yarn.lock', BERRY_CODEX], ['pnpm-lock.yaml', PNPM_DIRECT], ['package-lock.json', NPM]]) assert.equal(unreadable(run(path, text)).length, 0, path)
})

test('block scalars in pnpm entries can be indented any way (synthetic from the YAML spec)', () => {
  const text = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages:\n\n  old-thing@1.0.0:\n    resolution: {integrity: sha512-x}\n    deprecated: |-\n      Use new-thing.\n        Indented like this.\n       and this.\n    engines: {node: '>=14'}\n\n  other@2.0.0:\n    resolution: {integrity: sha512-y}\n\nsnapshots:\n\n  old-thing@1.0.0: {}\n\n  other@2.0.0: {}\n"
  const a = pnpm(text)
  assert.equal(unreadable(a).length, 0)
  assert.deepEqual(a.findings.map(f => f.name).sort(), ['old-thing', 'other'])
})

test('CRLF and a missing final newline read the same as the real files', () => {
  for (const [path, text] of [['yarn.lock', BERRY_CODEX], ['yarn.lock', BERRY_ESBUILD], ['pnpm-lock.yaml', PNPM_VITE], ['pnpm-lock.yaml', PNPM_DIRECT], ['package-lock.json', NPM]] as const) {
    const base = run(path, text)
    const shape = (a: ReturnType<typeof analyze>) => JSON.stringify([a.findings.map(f => [f.id, f.status, f.line]), issues(a)])
    assert.equal(shape(run(path, text.replace(/\n/g, '\r\n'))), shape(base), path)
    assert.equal(shape(run(path, text.replace(/\n+$/, ''))), shape(base), path)
  }
})

test('cutting a real lockfile anywhere never throws, and a cut inside an entry is never read as a complete file', () => {
  for (const [path, text] of [['yarn.lock', BERRY_ESBUILD], ['yarn.lock', fx('yarn-v1.react.lock')], ['pnpm-lock.yaml', PNPM_VITE], ['package-lock.json', NPM]] as const) {
    for (let k = 1; k < 40; k++) {
      const cut = Math.floor((text.length * k) / 40) + 3
      const a = run(path, text.slice(0, cut))
      assert.ok(a.files.length === 1 && Array.isArray(a.findings), `${path}@${cut}`)
    }
  }
  // a pnpm file cut in the middle of a key line has no valid entry for it
  const cutKey = pnpm(PNPM_DIRECT.slice(0, PNPM_DIRECT.indexOf('  lightningcss-darwin-arm64@')) + '  lightningcss-darw')
  assert.equal(issues(cutKey)[0]?.level, 'error')
})

test('the sample repo is scored exactly as before', () => {
  const a = analyze(SAMPLE_FILES)
  const rows = scoreServices(a.services.map(s => s.name), a.findings).map(s => [s.name, s.score, s.blockers, s.warnings, s.unknown, s.pending, s.ok])
  assert.deepEqual(rows, [['api', 69, 1, 1, 0, 9, 6], ['billing', 38, 2, 2, 0, 2, 4], ['postgres', 100, 0, 0, 0, 1, 0], ['queue', 100, 0, 0, 0, 1, 0], ['reports-db', 100, 0, 0, 0, 1, 0], ['traces', 100, 0, 0, 0, 1, 0], ['web', 75, 1, 0, 0, 2, 5], ['worker', 69, 1, 1, 0, 3, 2]])
  assert.equal(a.findings.length, 46)
  // the sample's package-lock.json has @img/sharp-linux-{x64,arm64} and @esbuild/linux-{x64,arm64}: no platform findings
  assert.equal(platform(a).length, 0)
})
