import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildxWorkflow, cliExportScript, k8sPatches, workloadKinds, worklist, worklistCsv } from './actions.ts'
import { classifyImage, classifyNpm, classifyPypi, parseManifestExport, platformsFromManifest, repoScore, scoreServices, wheelPlatforms } from './classify.ts'
import { armTarget, costLine, costSummary, DEFAULT_PRICES, hourly, parseCsv, parseInventory } from './cost.ts'
import { analyze, detectKind, instructions, osPackages, parseImageRef, reqLine, serviceOf, substitute } from './parse.ts'
import { resolveFindings, type Lookups } from './resolve.ts'
import { SAMPLE_FILES, SAMPLE_INVENTORY } from './sample.ts'
import type { Finding } from './types.ts'

const df = (text: string, path = 'svc/Dockerfile') => analyze([{ path, text }])
const find = (fs: Finding[], pred: (f: Finding) => boolean) => fs.find(pred)

test('image refs normalise Docker Hub library images, registries, tags and digests', () => {
  assert.equal(parseImageRef('python:3.12-slim')!.canonical, 'python:3.12-slim')
  assert.equal(parseImageRef('python')!.repo, 'library/python')
  assert.equal(parseImageRef('python')!.tag, 'latest')
  const g = parseImageRef('ghcr.io/org/app:1.2')!
  assert.deepEqual([g.registry, g.repo, g.tag], ['ghcr.io', 'org/app', '1.2'])
  const p = parseImageRef('localhost:5000/team/app')!
  assert.equal(p.registry, 'localhost:5000')
  assert.equal(parseImageRef('redis@sha256:abc')!.digest, 'sha256:abc')
  assert.equal(parseImageRef('${BASE}:1'), null)
})

test('format detection by name and by content', () => {
  assert.equal(detectKind('a/Dockerfile.prod', ''), 'dockerfile')
  assert.equal(detectKind('compose.yaml', ''), 'compose')
  assert.equal(detectKind('k/deploy.yaml', 'apiVersion: apps/v1\nkind: Deployment\n'), 'k8s')
  assert.equal(detectKind('pasted.txt', 'ARG X=1\nFROM alpine\n'), 'dockerfile')
  assert.equal(detectKind('requirements-dev.txt', 'x'), 'requirements')
  assert.equal(detectKind('nodes.csv', 'name,instance_type,count\n'), 'inventory')
  assert.equal(detectKind('paste', '{\n  "name": "x",\n  "lockfileVersion": 3'), 'package-lock')
  assert.equal(detectKind('notes.md', 'hello'), 'unknown')
})

test('Dockerfile: continuation lines keep the first line number and comments are dropped', () => {
  const ins = instructions('# c\nFROM a\nRUN echo 1 \\\n  && echo 2\n# x\nCMD x')
  assert.deepEqual(ins.map(i => [i.op, i.line]), [['FROM', 2], ['RUN', 3], ['CMD', 6]])
  assert.match(ins[1].args, /echo 1\s+&& echo 2/)
})

test('ARG substitution supports defaults and ${VAR:-x}', () => {
  assert.equal(substitute('a-${V}-$W-${Z:-d}', { V: '1', W: '2' }), 'a-1-2-d')
  const a = df('ARG PY=3.11\nFROM python:${PY}-slim\n')
  assert.equal(a.findings[0].name, 'python:3.11-slim')
})

test('Dockerfile: builder stages are build-role, final stage runtime; stage aliases and scratch are internal', () => {
  const a = df('FROM golang:1.22 AS build\nRUN go build\nFROM build AS test\nFROM scratch\nCOPY --from=build /x /x\n')
  const imgs = a.findings.filter(f => f.ecosystem === 'image')
  assert.equal(imgs.length, 1)
  assert.equal(imgs[0].role, 'build')
  const both = df('FROM node:20-alpine AS build\nRUN npm ci\nFROM node:20-alpine\n')
  const n = both.findings.filter(f => f.ecosystem === 'image')
  assert.equal(n.length, 1)
  assert.deepEqual([n[0].role, n[0].line], ['runtime', 3])
})

test('Dockerfile: hard-coded amd64 downloads block, TARGETARCH downloads pass', () => {
  const a = df('FROM debian\nARG V=1\nRUN curl -Lo /x https://ex.com/tool-${V}-linux-amd64.tar.gz\nARG TARGETARCH\nRUN curl -Lo /y https://ex.com/probe-linux-${TARGETARCH}\n')
  const bad = find(a.findings, f => f.ecosystem === 'binary' && f.status === 'block')!
  assert.ok(bad)
  assert.equal(bad.line, 3)
  assert.match(bad.fix!, /\$\{TARGETARCH\}/)
  assert.ok(find(a.findings, f => f.ecosystem === 'binary' && f.status === 'ok'))
})

test('Dockerfile: GOARCH=amd64, --platform=linux/amd64, [arch=amd64] apt sources and x86 lib paths are flagged', () => {
  const a = df('FROM --platform=linux/amd64 debian:12\nRUN echo "deb [arch=amd64] https://pkg.example.com stable main" > /etc/apt/sources.list.d/x.list\nRUN GOARCH=amd64 go build\nENV LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu\n')
  const titles = a.findings.map(f => f.title)
  assert.ok(titles.includes('Stage is pinned to linux/amd64'))
  assert.ok(titles.includes('apt repository pinned to amd64'))
  assert.ok(titles.includes('Go build hard-codes GOARCH'))
  assert.ok(titles.includes('Hard-coded x86_64 library path'))
})

test('apt/apk package extraction skips flags, versions and variables', () => {
  assert.deepEqual(osPackages('apt-get update && apt-get install -y --no-install-recommends curl=7.88 libpq5 $EXTRA && rm -rf x').map(p => p.name), ['curl', 'libpq5'])
  assert.deepEqual(osPackages('apk add --no-cache build-base git'), [{ mgr: 'apk', name: 'build-base' }, { mgr: 'apk', name: 'git' }])
  const a = df('FROM ubuntu\nRUN apt-get install -y google-chrome-stable\n')
  assert.equal(find(a.findings, f => f.name === 'google-chrome-stable')!.status, 'block')
})

test('Alpine final stage marks Python lookups as musl', () => {
  const a = analyze([{ path: 'x/Dockerfile', text: 'FROM python:3.12-alpine\n' }, { path: 'x/requirements.txt', text: 'numpy==2.0.0\n' }])
  assert.equal(find(a.findings, f => f.ecosystem === 'pypi')!.libc, 'musl')
})

test('requirements parsing: pins, extras, markers, includes and unpinned', () => {
  assert.deepEqual(reqLine('Flask[async]==3.0.3 ; python_version>"3.8"'), { name: 'flask', version: '3.0.3' })
  assert.deepEqual(reqLine('zope.interface>=6'), { name: 'zope-interface', version: undefined })
  const a = analyze([{ path: 'r/requirements.txt', text: '-r base.txt\nrequests\nnumpy==1.26.4\n!!bad\n' }])
  const issues = a.files[0].issues
  assert.ok(issues.some(i => i.line === 1 && /base\.txt/.test(i.message)))
  assert.ok(issues.some(i => i.line === 2 && /not pinned/.test(i.message)))
  assert.ok(issues.some(i => i.line === 4 && i.level === 'warn'))
  assert.equal(a.findings.filter(f => f.ecosystem === 'pypi').length, 2)
})

test('package-lock: curated natives, install-script lookups, platform packages skipped, pure counted', () => {
  const a = analyze(SAMPLE_FILES.filter(f => f.path === 'services/web/package-lock.json'))
  const by = (n: string) => find(a.findings, f => f.name === n)
  assert.equal(by('node-sass')!.status, 'block')
  assert.equal(by('sharp')!.status, 'ok')
  assert.equal(by('better-sqlite3')!.lookup, 'npm')
  assert.equal(by('@img/sharp-linux-x64'), undefined)
  assert.ok(a.findings.some(f => f.name.endsWith('pure-JS packages')))
  const bad = analyze([{ path: 'package-lock.json', text: '{"lockfileVersion": 3,\n "packages": {' }])
  assert.equal(bad.files[0].issues[0].level, 'error')
})

test('pom: x86_64 classifier blocks, old lz4 warns, property versions resolve', () => {
  const a = analyze(SAMPLE_FILES.filter(f => f.path === 'services/billing/pom.xml'))
  const netty = find(a.findings, f => f.name.startsWith('io.netty:netty-transport-native-epoll'))!
  assert.equal(netty.status, 'block')
  assert.equal(netty.version, '4.1.111.Final')
  assert.match(netty.fix!, /linux-aarch_64/)
  assert.equal(find(a.findings, f => f.name === 'org.lz4:lz4-java')!.status, 'warn')
  assert.equal(find(a.findings, f => f.name === 'org.rocksdb:rocksdbjni')!.status, 'ok')
})

test('go.mod, Gradle and Cargo.lock notes', () => {
  const go = analyze([{ path: 'w/go.mod', text: 'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/mattn/go-sqlite3 v1.14.22 // indirect\n\tgo.uber.org/zap v1.27.0\n)\n' }])
  assert.equal(find(go.findings, f => f.name === 'github.com/mattn/go-sqlite3')!.line, 6)
  const gr = analyze([{ path: 'j/gradle-deps.txt', text: '+--- org.fusesource.leveldbjni:leveldbjni-all:1.8\n' }])
  assert.equal(find(gr.findings, f => f.ecosystem === 'maven' && f.name.includes('leveldbjni'))!.status, 'block')
  const cg = analyze([{ path: 'r/Cargo.lock', text: '[[package]]\nname = "openssl-sys"\nversion = "0.9.1"\nchecksum = "x"\n\n[[package]]\nname = "zstd-sys"\nversion = "2.0.1"\n' }])
  assert.equal(cg.findings.filter(f => f.status === 'warn').length, 2)
})

test('compose and k8s: built-here images pass, amd64 pins are flagged, workloads become services', () => {
  const a = analyze(SAMPLE_FILES)
  const names = a.services.map(s => s.name)
  for (const s of ['api', 'web', 'worker', 'billing', 'reports-db', 'postgres']) assert.ok(names.includes(s), s)
  assert.equal(find(a.findings, f => f.service === 'api' && f.name === 'registry.example.com/shopfront/api:1.8.2')!.status, 'ok')
  assert.equal(find(a.findings, f => f.service === 'billing' && f.ecosystem === 'k8s')!.status, 'warn')
  assert.equal(find(a.findings, f => f.service === 'reports-db')!.lookup, 'image')
  assert.equal(find(a.findings, f => f.name === 'registry.example.com/shopfront/api:dev')!.status, 'ok')
  const cp = analyze([{ path: 'docker-compose.yml', text: 'services:\n  x:\n    image: foo/bar:1\n    platform: linux/amd64\n' }])
  assert.equal(find(cp.findings, f => f.ecosystem === 'k8s')!.status, 'block')
})

test('service grouping uses the nearest meaningful directory', () => {
  assert.equal(serviceOf('services/api/Dockerfile'), 'api')
  assert.equal(serviceOf('apps/Web/package-lock.json'), 'web')
  assert.equal(serviceOf('Dockerfile'), 'root')
})

test('image classification: multi-arch ok, amd64-only runtime blocks, build stage warns, arm/v7 is not arm64', () => {
  assert.equal(classifyImage({ ok: true, platforms: [{ os: 'linux', architecture: 'amd64' }, { os: 'linux', architecture: 'arm64', variant: 'v8' }] }).status, 'ok')
  assert.equal(classifyImage({ ok: true, platforms: [{ os: 'linux', architecture: 'amd64' }] }).status, 'block')
  assert.equal(classifyImage({ ok: true, platforms: [{ os: 'linux', architecture: 'amd64' }] }, 'build').status, 'warn')
  assert.match(classifyImage({ ok: true, platforms: [{ os: 'linux', architecture: 'arm', variant: 'v7' }] }).title, /32-bit/)
  assert.equal(classifyImage({ ok: false, error: '429' }).status, 'unknown')
})

test('manifest parsing: index with attestations, docker manifest inspect -v, CLI JSONL export', () => {
  const idx = { manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }, { platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } }, { platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } }] }
  assert.deepEqual(platformsFromManifest(idx)!.map(p => p.architecture), ['amd64', 'arm64'])
  assert.deepEqual(platformsFromManifest({ Ref: 'x', Descriptor: { platform: { os: 'linux', architecture: 'amd64' } } }), [{ os: 'linux', architecture: 'amd64' }])
  const rows = parseManifestExport(`{"ref":"a:1","manifest":${JSON.stringify(idx)}}\n{"ref":"b:2","manifest":null}\nnot json\n`)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].platforms!.length, 2)
  assert.equal(rows[1].platforms, null)
  assert.equal(rows[2].line, 3)
})

test('PyPI wheels: pure, manylinux aarch64, musl mismatch, sdist-only and nothing', () => {
  assert.deepEqual(wheelPlatforms('numpy-1.26.4-cp312-cp312-manylinux_2_17_aarch64.manylinux2014_aarch64.whl'), ['manylinux_2_17_aarch64', 'manylinux2014_aarch64'])
  const w = (n: string) => ({ filename: n, packagetype: 'bdist_wheel' })
  assert.equal(classifyPypi([w('flask-3.0.3-py3-none-any.whl')]).title, 'Pure-Python wheel')
  const np = [w('numpy-1.26.4-cp312-cp312-manylinux_2_17_aarch64.manylinux2014_aarch64.whl'), w('numpy-1.26.4-cp312-cp312-manylinux_2_17_x86_64.whl')]
  assert.equal(classifyPypi(np).status, 'ok')
  assert.equal(classifyPypi(np, 'musl').status, 'warn')
  assert.equal(classifyPypi([w('mysqlclient-2.2.4-cp312-cp312-win_amd64.whl'), { filename: 'mysqlclient-2.2.4.tar.gz', packagetype: 'sdist' }]).status, 'warn')
  assert.equal(classifyPypi([w('x-1-cp312-cp312-manylinux_2_17_x86_64.whl')]).status, 'block')
})

test('npm classification: arm64 optional package, prebuild loader, node-gyp, harmless postinstall', () => {
  assert.equal(classifyNpm('@swc/core', { optionalDependencies: { '@swc/core-linux-arm64-gnu': '1' } }).status, 'ok')
  assert.match(classifyNpm('better-sqlite3', { scripts: { install: 'prebuild-install || node-gyp rebuild --release' } }).title, /prebuilds/)
  assert.match(classifyNpm('x', { gypfile: true, scripts: { install: 'node-gyp rebuild' } }).title, /node-gyp/)
  assert.equal(classifyNpm('y', { scripts: { postinstall: 'node ./banner.js' } }).status, 'ok')
  assert.equal(classifyNpm('node-sass', {}).status, 'block')
})

test('scores: blockers dominate, pending shows scanning, repo score is the mean', () => {
  const f = (service: string, status: Finding['status']): Finding => ({ id: service + status + Math.random(), service, ecosystem: 'image', name: 'x', file: 'f', line: 1, status, title: '', detail: '', effort: 'S' })
  const s = scoreServices(['a', 'b', 'c'], [f('a', 'ok'), f('b', 'block'), f('b', 'warn'), f('c', 'pending')])
  assert.deepEqual(s.map(x => x.state), ['ready', 'blocked', 'scanning'])
  assert.equal(s[0].score, 100)
  assert.equal(s[1].score, 69)
  assert.equal(repoScore(s), Math.round((100 + 69 + 100) / 3))
})

test('resolve: de-duplicates lookups, applies overrides, survives lookup failures and reports progress', async () => {
  const a = analyze([
    { path: 'a/Dockerfile', text: 'FROM python:3.12-slim\nRUN pip install numpy==1.26.4\n' },
    { path: 'b/Dockerfile', text: 'FROM python:3.12-slim\n' },
    { path: 'c/Dockerfile', text: 'FROM vendor/legacy:1\n' },
    { path: 'd/Dockerfile', text: 'FROM broken/thing:1\n' },
  ])
  const calls: string[] = []
  const lk: Lookups = {
    image: async ref => { calls.push(ref); if (ref.startsWith('broken')) throw new Error('down'); return { ok: true, platforms: [{ os: 'linux', architecture: 'amd64' }, { os: 'linux', architecture: 'arm64' }] } },
    pypi: async () => ({ version: '1.26.4', files: [{ filename: 'numpy-1.26.4-cp312-cp312-manylinux_2_17_aarch64.whl', packagetype: 'bdist_wheel' }] }),
    npm: async () => null,
  }
  let last = 0
  const out = await resolveFindings(a.findings, lk, { overrides: { 'vendor/legacy:1': [{ os: 'linux', architecture: 'amd64' }] }, onUpdate: (_f, d) => { last = d } })
  assert.equal(calls.filter(c => c === 'python:3.12-slim').length, 1)
  assert.ok(!calls.includes('vendor/legacy:1'))
  assert.equal(out.find(f => f.name === 'vendor/legacy:1')!.status, 'block')
  assert.equal(out.find(f => f.name === 'broken/thing:1')!.status, 'unknown')
  assert.equal(out.find(f => f.ecosystem === 'pypi')!.status, 'ok')
  assert.ok(out.every(f => f.status !== 'pending'))
  assert.equal(last, 5)
  assert.equal(a.findings[0].status, 'pending', 'input is not mutated')
})

test('cost: hourly scaling, Graviton targets, perf factor rounding and break-even', () => {
  assert.equal(hourly('c5a.2xlarge', DEFAULT_PRICES), 0.308)
  assert.equal(armTarget('c5a.2xlarge', 'g4'), 'c8g.2xlarge')
  assert.equal(armTarget('t3.medium', 'g3'), 't4g.medium')
  assert.equal(armTarget('m7g.large', 'g4'), 'm7g.large')
  const l = costLine({ service: 'api', instance: 'c5a.2xlarge', count: 6, hours: 730 }, DEFAULT_PRICES, 'g4', 1)
  assert.equal(l.armCount, 6)
  assert.ok(l.delta > 0, 'c8g costs more per hour than c5a at equal performance')
  assert.equal(l.breakEven, +(0.31904 / 0.308).toFixed(3))
  const faster = costLine({ service: 'api', instance: 'c5a.2xlarge', count: 6, hours: 730, perf: 1.2 }, DEFAULT_PRICES, 'g4', 1)
  assert.equal(faster.armCount, 5)
  assert.ok(faster.delta < 0)
  const s = costSummary([l, faster])
  assert.equal(s.delta, Math.round((l.delta + faster.delta) * 100) / 100)
  assert.match(costLine({ service: 'x', instance: 'x9.large', count: 1, hours: 730 }, DEFAULT_PRICES, 'g4', 1).note!, /No price/)
})

test('inventory CSV: quoted cells, column guessing, line-numbered validation', () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""q"""\n1,2,3'), [['a', 'b, c', 'd "q"'], ['1', '2', '3']])
  const ok = parseInventory(SAMPLE_INVENTORY)
  assert.equal(ok.rows.length, 5)
  assert.equal(ok.rows[0].instance, 'c5a.2xlarge')
  const bad = parseInventory('nodegroup,InstanceType,desired\nx,c5.large,two\ny,banana,1\nz,m5.large,3\n')
  assert.deepEqual(bad.issues.map(i => i.line), [2, 3])
  assert.equal(bad.rows.length, 1)
})

test('actions: worklist ordering and CSV, CLI script, buildx workflow, k8s patches', () => {
  const a = analyze(SAMPLE_FILES)
  const w = worklist(a.findings)
  assert.equal(w[0].status, 'block')
  const csv = worklistCsv(a.findings, { [w[0].id]: 'done' })
  assert.match(csv.split('\n')[1], /,done$/)
  const script = cliExportScript(['redis:7', 'redis:7', 'mcr.microsoft.com/mssql/server:2022-latest'])
  assert.equal((script.match(/"redis:7"/g) ?? []).length, 1)
  assert.match(script, /docker manifest inspect -v/)
  const wf = buildxWorkflow({ registry: 'ghcr.io/acme/', services: a.services, runner: 'native' })
  assert.match(wf, /ubuntu-24\.04-arm/)
  assert.match(wf, /imagetools create -t ghcr\.io\/acme\//)
  assert.match(wf, /name: billing, context: services\/billing/)
  assert.match(buildxWorkflow({ registry: '', services: a.services, runner: 'qemu' }), /setup-qemu-action/)
  const kinds = workloadKinds(SAMPLE_FILES.find(f => f.path.endsWith('workloads.yaml'))!.text)
  assert.deepEqual(kinds.map(k => k.kind), ['Deployment', 'Deployment', 'Deployment', 'Deployment', 'StatefulSet'])
  const p = k8sPatches(kinds.slice(0, 2), { mode: 'required', taintKey: 'arch', taintValue: 'arm64' })
  assert.equal(p.length, 3)
  assert.match(p[0].text, /kubernetes\.io\/arch: arm64[\s\S]*key: arch/)
  assert.match(k8sPatches(kinds, { mode: 'preferred', taintKey: '', taintValue: '' })[0].text, /preferredDuringScheduling/)
})
