// Regression tests built from real public files. Fixtures are short excerpts that keep the original layout:
// - GoogleCloudPlatform/microservices-demo (Apache-2.0): src/*/Dockerfile, release/kubernetes-manifests.yaml
// - apache/superset (Apache-2.0): Dockerfile
// - getsentry/self-hosted (FSL-1.1-Apache-2.0): docker-compose.yml layout, service names changed
// - puppeteer/puppeteer (Apache-2.0): docker/Dockerfile
// - BurntSushi/ripgrep (MIT/Unlicense): Cargo.lock
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GET as pricesGET, slim } from '../../api/prices.js'
import { parseRef } from '../../api/manifest.js'
import { armTarget, costLine, DEFAULT_PRICES, EC2_PRICES, hourly, isArmFamily, splitType } from './cost.ts'
import { analyze, parseImageRef, serviceOf } from './parse.ts'
import type { Finding } from './types.ts'

const by = (fs: Finding[], pred: (f: Finding) => boolean) => fs.filter(pred)

const FRONTEND = `ARG BUILDPLATFORM=linux/amd64
FROM --platform=$BUILDPLATFORM golang:1.27.0-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS builder
ARG TARGETOS=linux
ARG TARGETARCH=amd64
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN GOOS=\${TARGETOS} GOARCH=\${TARGETARCH} CGO_ENABLED=0 go build -ldflags="-s -w" -o /go/bin/frontend .

FROM gcr.io/distroless/static
WORKDIR /src
COPY --from=builder /go/bin/frontend /src/server
ENTRYPOINT ["/src/server"]
`

const EMAIL = `ARG BUILDPLATFORM=linux/amd64
FROM --platform=$BUILDPLATFORM python:3.14.7-alpine@sha256:05b2b8b732ecd268fee8727a369f936f022d1321b59befd13c30ede22769dcdc AS base

FROM base AS builder
RUN apk update \\
    && apk add --no-cache g++ linux-headers \\
    && rm -rf /var/cache/apk/*
COPY requirements.txt .
RUN pip install -r requirements.txt

FROM base
RUN apk update \\
    && apk add --no-cache libstdc++ \\
    && rm -rf /var/cache/apk/*
WORKDIR /email_server
COPY --from=builder /usr/local/lib/python3.14/ /usr/local/lib/python3.14/
ENTRYPOINT [ "python", "email_server.py" ]
`

test('real: buildx platform ARG defaults are not treated as amd64 pins (microservices-demo frontend)', () => {
  const a = analyze([{ path: 'src/frontend/Dockerfile', text: FRONTEND }])
  assert.deepEqual(by(a.findings, f => f.status === 'block'), [], 'ARG BUILDPLATFORM=linux/amd64 and ARG TARGETARCH=amd64 are only fallbacks')
  const builder = a.findings.find(f => f.name.startsWith('golang:'))!
  assert.equal(builder.role, 'build')
  assert.equal(a.findings.find(f => f.name === 'gcr.io/distroless/static:latest')!.role, 'runtime')
})

test('real: ${BUILDPLATFORM:-amd64} is not a pin, a literal --platform=linux/amd64 still is (superset)', () => {
  const ok = analyze([{ path: 'Dockerfile', text: 'ARG BUILDPLATFORM=${BUILDPLATFORM:-amd64}\nFROM --platform=${BUILDPLATFORM} node:24-trixie-slim AS ui\nRUN npm ci\nFROM python:3.11-slim-trixie\nCOPY --from=ui /app /app\n' }])
  assert.equal(by(ok.findings, f => f.status === 'block').length, 0)
  const pinned = analyze([{ path: 'Dockerfile', text: 'FROM --platform=linux/amd64 node:24\n' }])
  assert.equal(by(pinned.findings, f => f.status === 'block').length, 1)
})

test('real: "FROM base" final stages resolve to the registry image, which ships (microservices-demo emailservice)', () => {
  const a = analyze([{ path: 'src/emailservice/Dockerfile', text: EMAIL }, { path: 'src/emailservice/requirements.txt', text: 'grpcio==1.76.0\n' }])
  const img = by(a.findings, f => f.ecosystem === 'image')
  assert.equal(img.length, 1)
  assert.equal(img[0].role, 'runtime')
  assert.equal(img[0].line, 2)
  assert.equal(a.services[0].language, 'Python')
  assert.equal(a.findings.find(f => f.name === 'grpcio')!.libc, 'musl', 'alpine behind the alias means musllinux wheels')
  const w = a.findings.find(f => f.name.includes('BUILDPLATFORM'))!
  assert.equal(w.status, 'warn', 'a runtime stage built on a $BUILDPLATFORM stage ships the build host architecture')
  // A cross-compiling builder with a clean final stage does not get that warning.
  assert.equal(analyze([{ path: 'x/Dockerfile', text: FRONTEND }]).findings.some(f => f.name.includes('BUILDPLATFORM')), false)
})

test('real: digest-pinned images keep their tag for display and for the registry lookup', () => {
  const r = parseImageRef('eclipse-temurin:25.0.4_7-jre-alpine@sha256:3137541deb3c')!
  assert.equal(r.name, 'eclipse-temurin:25.0.4_7-jre-alpine@sha256:3137541deb3c')
  assert.equal(r.canonical, 'eclipse-temurin@sha256:3137541deb3c', 'the stable finding id is unchanged')
  assert.equal(parseImageRef('redis@sha256:abc')!.name, 'redis@sha256:abc')
  assert.deepEqual(parseRef('python:3.14.7-alpine@sha256:05b2'), { host: 'docker.io', repo: 'library/python', ref: 'sha256:05b2', tag: '3.14.7-alpine' })
  assert.deepEqual(parseRef('mcr.microsoft.com/dotnet/sdk:10.0@sha256:c744'), { host: 'mcr.microsoft.com', repo: 'dotnet/sdk', ref: 'sha256:c744', tag: '10.0' })
  assert.equal(parseRef('quay.io/argoproj/argocd:v3.6.1')!.ref, 'v3.6.1')
  assert.equal(parseRef('localhost:5000/x'), null)
  assert.equal(parseRef('10.0.0.1/x:1'), null)
})

test('real: monorepo layout groups by the service directory, and deploy manifests join their Dockerfile', () => {
  assert.equal(serviceOf('microservices-demo/src/adservice/Dockerfile'), 'adservice')
  assert.equal(serviceOf('src/cartservice/src/Dockerfile'), 'cartservice')
  assert.equal(serviceOf('billing/src/main/docker/Dockerfile'), 'billing')
  const k8s = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  labels:
    app: frontend
spec:
  template:
    spec:
      containers:
        - name: server
          image: us-central1-docker.pkg.dev/online-boutique-ci/microservices-demo/frontend:v0.10.7
---
apiVersion: v1
kind: Service
metadata:
  name: frontend
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-cart
spec:
  template:
    spec:
      containers:
      - name: redis
        image: redis:alpine
`
  const a = analyze([
    { path: 'demo/src/frontend/Dockerfile', text: FRONTEND },
    { path: 'demo/src/frontend/go.mod', text: 'module github.com/GoogleCloudPlatform/microservices-demo/src/frontend\n\ngo 1.27\n\nrequire (\n\tgithub.com/gorilla/mux v1.8.1\n)\n' },
    { path: 'demo/src/emailservice/Dockerfile', text: EMAIL },
    { path: 'demo/src/emailservice/app/requirements.txt', text: 'grpcio==1.76.0\n' },
    { path: 'demo/release/kubernetes-manifests.yaml', text: k8s },
  ])
  assert.deepEqual(a.services.map(s => s.name), ['emailservice', 'frontend', 'redis-cart'])
  assert.equal(a.findings.find(f => f.name === 'grpcio')!.service, 'emailservice', 'a lockfile below the Dockerfile directory joins it')
  assert.equal(a.findings.find(f => f.file.endsWith('.yaml') && f.service === 'frontend')!.title, 'Built from this repo')
  assert.equal(a.findings.find(f => f.service === 'redis-cart')!.lookup, 'image')
})

test('real: compose anchors, ${VAR:-default} images and unresolved variables (sentry self-hosted layout)', () => {
  const text = `x-restart-policy: &restart_policy
  restart: unless-stopped
x-app-defaults: &app_defaults
  <<: *restart_policy
  image: app-self-hosted-local
  build:
    context: ./app
services:
  smtp:
    <<: *restart_policy
    image: registry.gitlab.com/egos-tech/smtp
  redis:
    image: "\${REDIS_IMAGE:-valkey/valkey:8.1.11-alpine}"
  relay:
    <<: *restart_policy
    image: "$RELAY_IMAGE"
  web:
    <<: *app_defaults
    ulimits:
      nofile: 4096
  worker:
    <<: [*app_defaults]
    command: run worker
volumes:
  data:
`
  const a = analyze([{ path: 'docker-compose.yml', text }])
  const f = (svc: string) => a.findings.find(x => x.service === svc)!
  assert.equal(f('smtp').name, 'registry.gitlab.com/egos-tech/smtp:latest')
  assert.equal(f('redis').name, 'valkey/valkey:8.1.11-alpine')
  assert.equal(f('relay').status, 'unknown')
  assert.equal(f('web').title, 'Built from this repo')
  assert.equal(f('worker').title, 'Built from this repo')
  assert.equal(a.services.length, 5)
})

test('real: Chrome for Testing installs block, chromium does not (puppeteer Dockerfile)', () => {
  const a = analyze([{ path: 'Dockerfile', text: 'FROM node:24-bookworm\nRUN apt-get update \\\n    && apt-get install -y --no-install-recommends fonts-ipafont-gothic dbus dbus-x11 \\\n    && PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer \\\n    npx puppeteer browsers install chrome --install-deps \\\n    && rm -rf /var/lib/apt/lists/*\n' }])
  const b = by(a.findings, x => x.status === 'block')
  assert.equal(b.length, 1)
  assert.match(b[0].title, /Chrome/)
  assert.equal(b[0].line, 2)
  assert.ok(a.findings.some(x => x.name === 'dbus-x11' && x.status === 'ok'))
  const pw = analyze([{ path: 'Dockerfile', text: 'FROM node:24\nRUN npx playwright install --with-deps chromium\n' }])
  assert.equal(by(pw.findings, x => x.status === 'block').length, 0)
})

test('real: Cargo.lock skips OS binding crates and explains jemalloc (ripgrep)', () => {
  const pkg = (n: string, v: string) => `[[package]]\nname = "${n}"\nversion = "${v}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "0000"\n`
  const text = '# This file is automatically @generated by Cargo.\nversion = 4\n\n' + [pkg('memchr', '2.7.6'), pkg('pcre2-sys', '0.2.10'), pkg('tikv-jemalloc-sys', '0.7.1+5.3.1-0-g81034ce1f1373e37dc865038e1bc8eeecf559ce8'), pkg('windows-sys', '0.61.2'), pkg('linux-raw-sys', '0.11.0'), pkg('js-sys', '0.3.80')].join('\n')
  const a = analyze([{ path: 'Cargo.lock', text }])
  const warn = by(a.findings, f => f.status === 'warn').map(f => f.name).sort()
  assert.deepEqual(warn, ['pcre2-sys', 'tikv-jemalloc-sys'])
  assert.match(a.findings.find(f => f.name === 'tikv-jemalloc-sys')!.title, /page size/)
})

test('prices: bundled AWS table covers every size, edits scale with the real size ratio', () => {
  assert.ok(Object.keys(EC2_PRICES).length > 1000)
  assert.equal(hourly('t3.micro', DEFAULT_PRICES), 0.0104)
  assert.equal(hourly('c5.9xlarge', DEFAULT_PRICES), 1.53)
  assert.equal(hourly('c5n.large', DEFAULT_PRICES), EC2_PRICES['c5n.large'], 'families outside the editable list are priced from the table')
  assert.equal(hourly('m7i-flex.large', DEFAULT_PRICES), EC2_PRICES['m7i-flex.large'])
  // A 30% Savings Plan style edit on the family row carries to every size.
  const edited = DEFAULT_PRICES.map(r => r.family === 'c5' ? { ...r, large: +(r.large * 0.7).toFixed(5) } : r)
  assert.equal(hourly('c5.9xlarge', edited), +(1.53 * 0.7).toFixed(5))
  assert.equal(splitType('m5.banana'), null)
  assert.equal(splitType('C5a.2XLarge')!.family, 'c5a')
  // Linear-by-vCPU holds within the families the app maps, which is what the size ratio relies on.
  for (const fam of ['m5', 'c5a', 'r6i', 'm8g', 'c7g']) assert.ok(Math.abs(EC2_PRICES[fam + '.4xlarge'] / EC2_PRICES[fam + '.large'] - 8) < 0.01, fam)
})

test('prices: Graviton targets keep d/n variants, step up a size or down a generation, and refuse unlike shapes', () => {
  assert.equal(armTarget('m5d.xlarge', 'g4'), 'm8gd.xlarge')
  assert.equal(armTarget('c5n.2xlarge', 'g4'), 'c8gn.2xlarge')
  assert.equal(armTarget('c5.9xlarge', 'g4'), 'c8g.12xlarge', 'c8g has no 9xlarge')
  assert.equal(armTarget('m7i-flex.large', 'g3'), 'm7g.large')
  assert.equal(armTarget('m5.metal', 'g4'), 'm8g.24xlarge', 'm5.metal is 96 vCPU')
  assert.equal(armTarget('t3.micro', 'g5'), 't4g.micro')
  assert.equal(armTarget('r5.large', 'g5'), 'r9g.large')
  assert.equal(armTarget('x1e.xlarge', 'g4'), null)
  assert.equal(armTarget('g4dn.xlarge', 'g4'), null)
  assert.ok(isArmFamily('c7gn') && isArmFamily('x2gd') && !isArmFamily('g4dn') && !isArmFamily('m7i'))
  // A region without the chosen generation falls back to the newest one it has.
  const region = { 'm5.large': 0.107, 'm7g.large': 0.091, 'm7g.xlarge': 0.182 }
  assert.equal(armTarget('m5.large', 'g5', region), 'm7g.large')
  const l = costLine({ service: 'api', instance: 'm5.large', count: 10, hours: 730 }, [], 'g5', 1.25, region)
  // Hand calculation: 10 x 0.107 x 730 = 781.10; ceil(10 / 1.25) = 8 x 0.091 x 730 = 531.44; break-even 0.091 / 0.107.
  assert.deepEqual([l.armCount, l.current, l.projected, l.delta, l.breakEven], [8, 781.1, 531.44, -249.66, 0.85])
})

test('prices: the AWS price file is reduced to type -> hourly price, unknown regions are rejected', async () => {
  const name = 'EU (Ireland)'
  const file = { manifest: { hawkFilePublicationDate: '2026-11-14T17:38:52Z' }, regions: { [name]: {
    'c7gn large EU Ireland Linux': { price: '0.1396000000', 'Instance Type': 'c7gn.large', vCPU: '2' },
    'm7g large EU Ireland Linux': { price: '0.0910000000', 'Instance Type': 'm7g.large', vCPU: '2' },
    'free': { price: '0.0000000000', 'Instance Type': 'zero.large' },
  } } }
  assert.deepEqual(slim(file, name), { asOf: '2026-11-14', prices: { 'c7gn.large': 0.1396, 'm7g.large': 0.091 } })
  assert.deepEqual(slim({}, name), { asOf: '', prices: {} })
  assert.equal((await pricesGET(new Request('http://x/api/prices?region=moon-1'))).status, 400)
})
