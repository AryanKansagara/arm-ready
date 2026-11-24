// yarn.lock and pnpm-lock.yaml tests. Fixtures in ./fixtures are excerpts of real public lockfiles. Entries keep their original
// text; the header and the entries that exercise a case are kept, everything else is cut. Sources (raw file at the named commit):
//
//   yarn-v1.react.lock             facebook/react (MIT)            yarn.lock @ 89d7b2b4afda0e557dca094fa571779259e853db
//   yarn-v1.firebase-git.lock      firebase/firebase-js-sdk (Apache-2.0)  yarn.lock @ a086865b469580a3c9e76eae810e467a3dc7334f
//   yarn-berry-v10.babel.lock      babel/babel (MIT)               yarn.lock @ 10d1c4f5f1a94c3402b77b320a19d46815040123
//   yarn-berry-v10.berry-git.lock  yarnpkg/berry (BSD-2-Clause)    yarn.lock @ cfa40bda203d1b0a8cc25886af19bc11b670ef84
//   yarn-berry-v8.lock             yarnpkg/berry                   yarn.lock @ c6764b28f8e8dbdac7ad318d6d98b5d5f0f4679e (tag @yarnpkg/cli/4.0.0)
//   yarn-berry-v6.lock             yarnpkg/berry                   yarn.lock @ 98c9662047200aec924e34664ba53293474c93bc (tag @yarnpkg/cli/3.6.0)
//   yarn-berry-v4.lock             yarnpkg/berry                   yarn.lock @ 5224d543f5524f4bdbe46df8b8f0799fdb442a67 (tag @yarnpkg/cli/3.0.0)
//   pnpm-v9.vite.yaml              vitejs/vite (MIT)               pnpm-lock.yaml @ 942f6d73df1c990865550bf4fafae3b8893b0f66 (two documents: environment, then project)
//   pnpm-v9.astro-file-entries.yaml withastro/astro (MIT)          pnpm-lock.yaml @ f70283dc70c05ef862bc3c5d115efd273cab8cd7 (file: and link: entries)
//   pnpm-v6.vite.yaml              vitejs/vite (MIT)               pnpm-lock.yaml @ 2fce647edae3c93915f43c2a2971b87aa2db53c3 (lockfileVersion 6.0, requiresBuild)
//   pnpm-v13.pnpm.yaml             pnpm/pnpm (MIT)                 pnpm-lock.yaml @ 4396ef2399d43c3ced772b05e8f18add632c4bde (lockfileVersion 13.0, JSON-style document)
//
// Layouts follow the package managers' own sources and docs:
//   yarnpkg/yarn src/lockfile/{stringify,parse}.js, yarnpkg/berry packages/yarnpkg-core/sources/Project.ts,
//   pnpm/pnpm docs/lockfile-format.md, pnpm/spec lockfile/{6.0,9.0}.md.
// Tests marked "synthetic" edit a header or build a tiny file from the documented layout because no real file shows the case.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { scoreServices } from './classify.ts'
import { analyze, detectKind, KIND_LABEL, NPM_LOOKUP_LIMIT } from './parse.ts'
import { resolveFindings, type Lookups } from './resolve.ts'
import type { Finding } from './types.ts'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const YARN1 = fx('yarn-v1.react.lock')
const YARN1_GIT = fx('yarn-v1.firebase-git.lock')
const BERRY10 = fx('yarn-berry-v10.babel.lock')
const BERRY_GIT = fx('yarn-berry-v10.berry-git.lock')
const PNPM9 = fx('pnpm-v9.vite.yaml')
const PNPM9_FILE = fx('pnpm-v9.astro-file-entries.yaml')
const PNPM6 = fx('pnpm-v6.vite.yaml')
const PNPM13 = fx('pnpm-v13.pnpm.yaml')

const yarn = (text: string) => analyze([{ path: 'api/yarn.lock', text }])
const pnpm = (text: string) => analyze([{ path: 'api/pnpm-lock.yaml', text }])
const named = (a: { findings: Finding[] }, name: string) => a.findings.filter(f => f.name === name)
const one = (a: { findings: Finding[] }, id: string) => a.findings.find(f => f.id.endsWith(`|npm|${id}`))
/** 1-based line of the first line that starts with `prefix`. */
const lineOf = (text: string, prefix: string) => text.split('\n').findIndex(l => l.startsWith(prefix)) + 1
const issues = (a: ReturnType<typeof analyze>) => a.files[0].issues
const unreadable = (a: ReturnType<typeof analyze>) => a.findings.filter(f => f.title === 'Lockfile could not be read')

test('detection: file names, pasted text, labels, language', () => {
  assert.equal(detectKind('yarn.lock', ''), 'yarn-lock')
  assert.equal(detectKind('apps/web/pnpm-lock.yaml', ''), 'pnpm-lock')
  assert.equal(detectKind('paste', YARN1), 'yarn-lock')
  assert.equal(detectKind('paste', BERRY10), 'yarn-lock')
  assert.equal(detectKind('paste', PNPM9), 'pnpm-lock')
  assert.equal(detectKind('paste', PNPM6), 'pnpm-lock')
  // A renamed pnpm lockfile must not be taken for Compose or Kubernetes YAML.
  assert.equal(detectKind('lock.yaml', PNPM9_FILE), 'pnpm-lock')
  assert.equal(KIND_LABEL['yarn-lock'], 'yarn.lock')
  assert.equal(KIND_LABEL['pnpm-lock'], 'pnpm-lock.yaml')
  for (const [path, text] of [['svc/yarn.lock', YARN1], ['svc/pnpm-lock.yaml', PNPM9]]) {
    const a = analyze([{ path, text }])
    assert.equal(a.services[0].language, 'Node.js')
    assert.equal(a.files[0].items, a.findings.length)
    assert.ok(a.files[0].items > 0)
  }
})

test('ordering: lockfiles are read after package-lock.json and before go.mod, in any upload order', () => {
  const a = analyze([
    { path: 'x/go.mod', text: 'module x\n\ngo 1.22\n' },
    { path: 'x/pnpm-lock.yaml', text: PNPM9 },
    { path: 'x/yarn.lock', text: YARN1 },
    { path: 'x/package-lock.json', text: '{"lockfileVersion":3,"packages":{}}' },
    { path: 'x/Dockerfile', text: 'FROM node:22-slim\n' },
  ])
  assert.deepEqual(a.files.map(f => f.kind), ['dockerfile', 'package-lock', 'yarn-lock', 'pnpm-lock', 'go-mod'])
  assert.equal(a.services.length, 1)
})

test('Yarn 1 (facebook/react): scoped names, several versions, aliases, link entries, native-build helpers', () => {
  const a = yarn(YARN1)
  assert.equal(a.files[0].kind, 'yarn-lock')
  // Two versions of a scoped package: keyed by name@version, each on its own entry line.
  const cf = a.findings.filter(f => f.name === '@babel/code-frame')
  assert.deepEqual(cf.map(f => f.version).sort(), ['7.12.11', '7.24.2'])
  assert.deepEqual(cf.map(f => f.id.split('|')[2]).sort(), ['@babel/code-frame@7.12.11', '@babel/code-frame@7.24.2'])
  assert.equal(cf.find(f => f.version === '7.12.11')!.line, lineOf(YARN1, '"@babel/code-frame@7.12.11"'))
  assert.equal(cf.find(f => f.version === '7.24.2')!.line, lineOf(YARN1, '"@babel/code-frame@^7.0.0"'))
  assert.equal(lineOf(YARN1, '"@babel/code-frame@7.12.11"'), 5) // pinned to the excerpt, so a parser line offset cannot hide
  // Alias: "@typescript-eslint/parser-v5@npm:@typescript-eslint/parser@^5.62.0" installs the real package.
  assert.equal(named(a, '@typescript-eslint/parser')[0].version, '5.62.0')
  assert.equal(named(a, '@typescript-eslint/parser-v5').length, 0)
  assert.equal(one(a, '@typescript-eslint/parser')!.line, lineOf(YARN1, '"@typescript-eslint/parser-v5@npm:'))
  // Several versions of semver.
  assert.deepEqual(named(a, 'semver').map(f => f.version).sort(), ['5.7.3', '7.8.6'])
  // A link: entry is the repo's own code: reported once, never a finding.
  assert.equal(named(a, 'eslint-plugin-react-internal').length, 0)
  const local = issues(a).find(i => /local entries/.test(i.message))!
  assert.equal(local.level, 'info')
  assert.equal(local.line, lineOf(YARN1, '"eslint-plugin-react-internal@link:'))
  assert.match(local.message, /^1 local entries/)
  // fsevents is curated; nan and bindings are checked live. Yarn 1 records no install scripts, so nothing is called "pure".
  assert.equal(named(a, 'fsevents').length, 2)
  assert.ok(named(a, 'fsevents').every(f => f.status === 'ok' && !f.lookup))
  assert.deepEqual(['nan', 'bindings', 'core-js'].map(n => named(a, n)[0].lookup), ['npm', 'npm', 'npm'])
  assert.ok(!a.findings.some(f => /pure/i.test(f.name)))
})

test('Yarn 1 (firebase-js-sdk): git entries are reported, not looked up on npm', () => {
  const a = yarn(YARN1_GIT)
  const git = a.findings.filter(f => f.title === 'Not installed from the npm registry')
  assert.deepEqual(git.map(f => f.name).sort(), ['closure-net', 'websql'])
  assert.ok(git.every(f => f.status === 'unknown' && !f.lookup))
  assert.equal(git.find(f => f.name === 'closure-net')!.line, lineOf(YARN1_GIT, '"closure-net@git+'))
  const warns = issues(a).filter(i => i.level === 'warn')
  assert.equal(warns.length, 2)
  assert.match(warns[0].message, /closure-net comes from git\+https:\/\/github\.com\/google\/closure-net\.git/)
  assert.equal(warns[1].line, lineOf(YARN1_GIT, '"websql@git+'))
  // The registry package next to them is still checked.
  assert.equal(named(a, 'cmd-shim')[0].lookup, 'npm')
})

test('Yarn Berry v10 (babel): descriptors, aliases via resolution, workspace/link, patch and conditions', () => {
  const a = yarn(BERRY10)
  assert.deepEqual(a.findings.filter(f => f.name === '@babel/code-frame').map(f => f.version).sort(), ['7.12.11', '7.29.7', '8.0.6'])
  assert.equal(one(a, '@babel/code-frame@7.29.7')!.line, lineOf(BERRY10, '"@babel/code-frame@npm:^7.0.0'))
  // "string-width-cjs@npm:string-width@^4.2.0" resolves to string-width 4.2.3.
  assert.equal(named(a, 'string-width')[0].version, '4.2.3')
  assert.equal(named(a, 'string-width-cjs').length, 0)
  assert.equal(named(a, 'string-width')[0].line, lineOf(BERRY10, '"string-width-cjs@npm:'))
  // $repo-utils@link and @babel/code-frame@workspace are the repo's own packages.
  const local = issues(a).find(i => /local entries/.test(i.message))!
  assert.match(local.message, /^2 local entries/)
  assert.equal(local.line, lineOf(BERRY10, '"$repo-utils@link:'))
  // fsevents has conditions: os=darwin; the patch: entries shadow npm entries. Neither is a finding.
  assert.equal(named(a, 'fsevents').length, 0)
  assert.equal(named(a, 'resolve').length, 0)
  assert.ok(!a.findings.some(f => f.title === 'Lockfile could not be read'))
})

test('Yarn Berry v10 (yarnpkg/berry): a git resolution is reported with its source line', () => {
  const a = yarn(BERRY_GIT)
  const pem = named(a, 'pem')[0]
  assert.equal(pem.status, 'unknown')
  assert.equal(pem.title, 'Not installed from the npm registry')
  assert.equal(pem.line, lineOf(BERRY_GIT, 'pem@dexus/pem'))
  assert.match(issues(a).find(i => i.level === 'warn')!.message, /pem comes from https:\/\/github\.com\/dexus\/pem\.git/)
  assert.equal(named(a, 'pegjs')[0].lookup, 'npm')
})

test('Yarn Berry metadata versions 4, 6, 8 and 10 all read; others are an error', () => {
  for (const [file, v] of [['yarn-berry-v4.lock', 4], ['yarn-berry-v6.lock', 6], ['yarn-berry-v8.lock', 8]] as const) {
    const text = fx(file)
    assert.match(text, new RegExp(`__metadata:\\n  version: ${v}\\n`))
    const a = yarn(text)
    assert.equal(a.findings.length, a.findings.filter(f => f.lookup === 'npm').length, file)
    assert.ok(a.findings.length >= 2, file)
    assert.equal(named(a, '@actions/core')[0].version, '1.2.6')
    assert.equal(named(a, '@actions/core')[0].line, lineOf(text, '"@actions/core@npm:'))
    assert.equal(unreadable(a).length, 0, file)
  }
  // synthetic: the same real file with only the version line changed.
  for (const bad of [3, 11, 99]) {
    const a = yarn(fx('yarn-berry-v8.lock').replace('  version: 8\n', `  version: ${bad}\n`))
    assert.equal(issues(a)[0].level, 'error')
    assert.match(issues(a)[0].message, new RegExp(`__metadata version ${bad} is not supported.*4 to 10`))
    assert.equal(issues(a)[0].line, 4)
    assert.equal(unreadable(a).length, 1)
    assert.ok(!a.findings.some(f => f.lookup || f.status === 'ok'))
  }
  // synthetic: no version at all, and a Yarn 1 style file with a different header version.
  assert.equal(issues(yarn('__metadata:\n  cacheKey: 8\n'))[0].level, 'error')
  assert.match(issues(yarn('# yarn lockfile v2\n\nfoo@^1:\n  version "1.0.0"\n'))[0].message, /yarn lockfile v2/)
  assert.equal(issues(yarn('not a lockfile\n'))[0].level, 'error')
  // A valid file without packages is not an error, but it says so.
  assert.equal(issues(yarn('# yarn lockfile v1\n\n'))[0].level, 'info')
  assert.equal(unreadable(yarn('# yarn lockfile v1\n\n')).length, 0)
})

test('an unreadable lockfile never makes the service look ready', () => {
  for (const a of [yarn(fx('yarn-berry-v8.lock').replace('  version: 8\n', '  version: 99\n')), pnpm(PNPM13)]) {
    assert.equal(unreadable(a).length, 1)
    const s = scoreServices(a.services.map(x => x.name), a.findings)[0]
    assert.equal(s.state, 'needs-work')
    assert.equal(s.unknown, 1)
  }
})

test('two unreadable lockfiles in one service are both reported', () => {
  const a = analyze([{ path: 'api/pnpm-lock.yaml', text: PNPM13 }, { path: 'api/yarn.lock', text: 'not a lockfile\n' }])
  assert.deepEqual(unreadable(a).map(f => f.file).sort(), ['api/pnpm-lock.yaml', 'api/yarn.lock'])
})

test('pnpm 9 (vite): environment document skipped, absolute lines, peer suffixes, platform packages, multiple versions', () => {
  const a = pnpm(PNPM9)
  assert.equal(a.files[0].kind, 'pnpm-lock')
  const env = issues(a).find(i => /environment document/.test(i.message))!
  assert.equal(env.level, 'info')
  assert.equal(env.line, 2)
  assert.match(env.message, /before line 49/)
  assert.equal(PNPM9.split('\n')[47], '---') // the project document starts on line 49
  assert.ok(!a.findings.some(f => f.name.startsWith('@pnpm/exe')), 'the environment document is not scanned')
  assert.ok(!a.findings.some(f => /\(/.test(f.name + f.id + (f.version ?? ''))), 'peer suffixes are stripped')
  // Entries come from the packages section; lines are positions in the whole file.
  const packagesAt = PNPM9.split('\n').map((l, i) => (l === 'packages:' ? i : -1)).filter(i => i >= 0)[1]
  const core = named(a, '@babel/core')[0]
  assert.equal(core.version, '7.29.13')
  assert.equal(core.line, packagesAt + 1 + PNPM9.split('\n').slice(packagesAt).findIndex(l => l.startsWith("  '@babel/core@7.29.13':")))
  assert.deepEqual(named(a, 'vue').map(f => f.version).sort(), ['3.4.38', '3.5.45'])
  assert.deepEqual(named(a, 'obug').map(f => f.version).sort(), ['1.0.2', '3.0.0'])
  assert.deepEqual(named(a, 'vue').map(f => f.id.split('|')[2]).sort(), ['vue@3.4.38', 'vue@3.5.45'])
  // os: [darwin] is skipped; esbuild and sharp are curated; the rest is looked up.
  assert.equal(named(a, 'fsevents').length, 0)
  assert.equal(named(a, 'esbuild')[0].status, 'ok')
  assert.equal(named(a, 'sharp')[0].source, 'curated')
  assert.equal(named(a, 'core-js')[0].lookup, 'npm')
  // @parcel/watcher depends on node-addon-api (see the snapshots section), so it is checked first.
  assert.equal(a.findings[0].name, '@parcel/watcher')
  // link:packages/vite is the repo's own package.
  assert.match(issues(a).find(i => /local entries/.test(i.message))!.message, /^1 local entries/)
  assert.equal(unreadable(a).length, 0)
})

test('pnpm 9 (astro): file: and link: entries are local; registry entries stay', () => {
  const a = pnpm(PNPM9_FILE)
  assert.deepEqual(a.findings.map(f => f.name).sort(), ['@testing-library/dom', 'svelte'])
  const local = issues(a).find(i => /local entries/.test(i.message))!
  // three link: importer versions + three file: package entries (a directory, a tarball, a directory with peers).
  assert.match(local.message, /^6 local entries/)
  assert.ok(local.line > 0)
  assert.equal(named(a, 'fake-data-pkg').length + named(a, 'fake-svelte-pkg').length, 0)
})

test('pnpm 6.0 (vite): /name@version ids, peer suffixes, requiresBuild checked first, platform packages skipped', () => {
  const a = pnpm(PNPM6)
  assert.equal(named(a, '@algolia/autocomplete-core')[0].version, '1.9.3')
  assert.equal(named(a, '@algolia/autocomplete-core')[0].line, lineOf(PNPM6, '  /@algolia/autocomplete-core@1.9.3(algoliasearch@4.20.0):'))
  assert.deepEqual(named(a, 'vue').map(f => f.version).sort(), ['3.2.0', '3.3.9'])
  assert.deepEqual(named(a, 'esbuild').map(f => f.version).sort(), ['0.18.20', '0.19.3'])
  assert.equal(named(a, 'fsevents').length, 0) // os: [darwin]
  // requiresBuild: true is a known install script: checked live, and before packages with no information.
  assert.equal(a.findings[0].name, '@babel/highlight')
  assert.equal(a.findings[0].lookup, 'npm')
  assert.equal(unreadable(a).length, 0)
})

test('pnpm: git and tarball entries are reported explicitly (synthetic, from the lockfile-format docs resolution table)', () => {
  const text = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      hello:
        specifier: https://codeload.github.com/example/hello/tar.gz/0123456789abcdef
        version: https://codeload.github.com/example/hello/tar.gz/0123456789abcdef

packages:

  hello@https://codeload.github.com/example/hello/tar.gz/0123456789abcdef:
    resolution: {tarball: https://codeload.github.com/example/hello/tar.gz/0123456789abcdef}
    version: 1.0.0

  tools@git+https://example.com/tools.git#0123456789abcdef:
    resolution: {commit: 0123456789abcdef, repo: https://example.com/tools.git, type: git}
    version: 2.0.0

  left-pad@1.3.0:
    resolution: {integrity: sha512-xxx}

snapshots:

  hello@https://codeload.github.com/example/hello/tar.gz/0123456789abcdef: {}

  tools@git+https://example.com/tools.git#0123456789abcdef: {}

  left-pad@1.3.0: {}
`
  const a = pnpm(text)
  const remote = a.findings.filter(f => f.title === 'Not installed from the npm registry')
  assert.deepEqual(remote.map(f => [f.name, f.line]).sort(), [['hello', lineOf(text, '  hello@https')], ['tools', lineOf(text, '  tools@git')]].sort())
  assert.ok(remote.every(f => f.status === 'unknown' && !f.lookup))
  assert.equal(issues(a).filter(i => i.level === 'warn').length, 2)
  assert.equal(named(a, 'left-pad')[0].lookup, 'npm')
})

test('pnpm: unsupported or missing lockfileVersion is an error with a clear message', () => {
  const a = pnpm(PNPM13)
  assert.equal(issues(a)[0].level, 'error')
  assert.match(issues(a)[0].message, /lockfileVersion 13\.0 is not supported.*9\.x.*6\.x/)
  assert.equal(issues(a)[0].line, lineOf(PNPM13, '\t"lockfileVersion"'))
  assert.ok(!a.findings.some(f => f.lookup || f.status === 'ok'))
  // synthetic: header changes on a real file.
  for (const v of ['5.4', '7.0', '12.0', '10.0']) {
    const b = pnpm(PNPM6.replace("lockfileVersion: '6.0'", `lockfileVersion: '${v}'`))
    assert.match(issues(b)[0].message, new RegExp(`lockfileVersion ${v.replace('.', '\\.')} is not supported`), v)
    assert.equal(issues(b)[0].line, 1)
    assert.equal(unreadable(b).length, 1)
    assert.ok(!b.findings.some(f => f.lookup))
  }
  assert.match(issues(pnpm('lockfileVersion: 5.4\n'))[0].message, /pnpm 7 and earlier/)
  assert.match(issues(pnpm('packages:\n  a@1.0.0: {}\n'))[0].message, /No lockfileVersion/)
  assert.equal(issues(pnpm('\n'))[0].level, 'error')
})

test('lookups are bounded and the unchecked rest is reported as unknown, never as pure (synthetic: generated yarn.lock)', () => {
  const N = NPM_LOOKUP_LIMIT + 60
  const entry = (name: string, deps = '') => `${name}@^1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/${name}/-/${name}-1.0.0.tgz#abc"\n${deps}\n`
  let text = '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n'
  for (let i = 0; i < N; i++) text += entry(`pkg-${String(i).padStart(3, '0')}`)
  // The last entry depends on nan, so it is checked ahead of the 100 before it.
  text += entry('late-addon', '  dependencies:\n    nan "^2.12.1"\n')
  const a = yarn(text)
  const pending = a.findings.filter(f => f.lookup === 'npm')
  assert.equal(pending.length, NPM_LOOKUP_LIMIT)
  assert.ok(pending.some(f => f.name === 'late-addon'))
  assert.ok(!pending.some(f => f.name === `pkg-${String(N - 1).padStart(3, '0')}`))
  const rest = a.findings.filter(f => f.title === 'Install scripts not checked')
  assert.equal(rest.length, 1)
  assert.equal(rest[0].status, 'unknown')
  assert.equal(rest[0].name, `${N + 1 - NPM_LOOKUP_LIMIT} packages`)
  // late-addon took the first slot, so pkg-099 is the first entry left out.
  assert.equal(rest[0].line, lineOf(text, `pkg-${String(NPM_LOOKUP_LIMIT - 1).padStart(3, '0')}@`))
  assert.match(issues(a).find(i => i.level === 'warn')!.message, /not looked up on npm/)
  assert.ok(!a.findings.some(f => f.status === 'ok'))
  // A second lockfile in the same scan only gets what is left of the budget.
  const b = analyze([{ path: 'a/yarn.lock', text }, { path: 'b/yarn.lock', text: entry('other').replace(/^/, '# yarn lockfile v1\n\n') }])
  assert.equal(b.findings.filter(f => f.lookup === 'npm').length, NPM_LOOKUP_LIMIT)
  assert.ok(b.findings.some(f => f.title === 'Install scripts not checked' && f.file === 'b/yarn.lock' && f.name === '1 packages'))
})

test('lookups run with name and version, and verdicts land on the right entries', async () => {
  const a = yarn(YARN1)
  const calls: string[] = []
  const lk: Lookups = {
    async image() { throw new Error('no images') },
    async pypi() { throw new Error('no pypi') },
    async npm(name, version) {
      calls.push(`${name}@${version}`)
      return name === 'nan' ? { name, version, gypfile: true, scripts: { install: 'node-gyp rebuild' } } : { name, version }
    },
  }
  const out = await resolveFindings(a.findings, lk)
  assert.ok(calls.length > 0 && calls.length <= NPM_LOOKUP_LIMIT)
  assert.ok(calls.includes('nan@2.14.1') && calls.includes('semver@5.7.3') && calls.includes('semver@7.8.6'))
  assert.equal(calls.length, new Set(calls).size)
  assert.equal(out.find(f => f.name === 'nan')!.status, 'warn')
  assert.equal(out.find(f => f.name === 'core-js')!.status, 'ok')
  assert.ok(!out.some(f => f.status === 'pending'))
})
