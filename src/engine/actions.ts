import { toCsv } from './cost.ts'
import type { Finding, Service } from './types.ts'

export type WorkState = 'open' | 'doing' | 'done' | 'wontfix'

const RANK = { block: 0, warn: 1, unknown: 2, pending: 3, ok: 4 } as const

/** Findings that need someone to do something, worst first. */
export function worklist(findings: Finding[]): Finding[] {
  return findings.filter(f => f.status === 'block' || f.status === 'warn' || f.status === 'unknown')
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.service.localeCompare(b.service) || a.file.localeCompare(b.file) || a.line - b.line)
}

export function worklistCsv(findings: Finding[], state: Record<string, WorkState> = {}): string {
  const sev = { block: 'Blocker', warn: 'Warning', unknown: 'Unverified', ok: 'OK', pending: 'Pending' }
  return toCsv([
    ['Severity', 'Service', 'Ecosystem', 'Item', 'Version', 'File', 'Line', 'Issue', 'Detail', 'Fix', 'Effort', 'Status'],
    ...worklist(findings).map(f => [sev[f.status], f.service, f.ecosystem, f.name, f.version ?? '', f.file, f.line, f.title, f.detail, f.fix ?? '', f.effort, state[f.id] ?? 'open']),
  ])
}

/** Images to verify by hand: everything that is still unknown, plus all runtime images when `all` is set. */
export function cliExportScript(refs: string[]): string {
  const list = [...new Set(refs)].sort()
  return `#!/usr/bin/env bash
# Exports platform lists for the images below so Arm Ready can read them offline.
# Needs Docker 20.10+ and access to the registries (run docker login first for private ones).
# Usage: bash arm-ready-manifests.sh > arm-ready-manifests.jsonl   then import the .jsonl file.
set -u
images=(
${list.map(r => `  "${r}"`).join('\n')}
)
for img in "\${images[@]}"; do
  if m=$(docker manifest inspect -v "$img" 2>/dev/null); then
    printf '{"ref":"%s","manifest":%s}\\n' "$img" "$(printf '%s' "$m" | tr -d '\\n')"
  else
    printf '{"ref":"%s","manifest":null}\\n' "$img"
    echo "could not inspect $img" >&2
  fi
done
`
}

export interface CiOptions { registry: string; services: Service[]; runner: 'native' | 'qemu' }

/** A GitHub Actions workflow that builds each Dockerfile for amd64 and arm64 and pushes one multi-arch tag. */
export function buildxWorkflow({ registry, services, runner }: CiOptions): string {
  const built = services.filter(s => s.dockerfile)
  const reg = registry.replace(/\/+$/, '') || 'ghcr.io/your-org'
  const matrixSvc = built.map(s => `          - { name: ${s.name}, context: ${dirOf(s.dockerfile!)}, dockerfile: ${s.dockerfile} }`).join('\n') || '          - { name: app, context: ., dockerfile: Dockerfile }'
  if (runner === 'qemu') return `# .github/workflows/multi-arch.yml  (QEMU emulation: simplest, but arm64 steps run 3-10x slower)
name: multi-arch images
on: { push: { branches: [main] } }
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        svc:
${matrixSvc}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ${reg.split('/')[0]}, username: \${{ github.actor }}, password: \${{ secrets.GITHUB_TOKEN }} }
      - uses: docker/build-push-action@v6
        with:
          context: \${{ matrix.svc.context }}
          file: \${{ matrix.svc.dockerfile }}
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${reg}/\${{ matrix.svc.name }}:\${{ github.sha }}
          cache-from: type=gha,scope=\${{ matrix.svc.name }}
          cache-to: type=gha,mode=max,scope=\${{ matrix.svc.name }}
`
  return `# .github/workflows/multi-arch.yml  (native runners: each platform builds on its own CPU, no emulation)
name: multi-arch images
on: { push: { branches: [main] } }
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        svc:
${matrixSvc}
        platform:
          - { arch: amd64, runner: ubuntu-24.04 }
          - { arch: arm64, runner: ubuntu-24.04-arm }
    runs-on: \${{ matrix.platform.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ${reg.split('/')[0]}, username: \${{ github.actor }}, password: \${{ secrets.GITHUB_TOKEN }} }
      - id: build
        uses: docker/build-push-action@v6
        with:
          context: \${{ matrix.svc.context }}
          file: \${{ matrix.svc.dockerfile }}
          platforms: linux/\${{ matrix.platform.arch }}
          outputs: type=image,name=${reg}/\${{ matrix.svc.name }},push-by-digest=true,name-canonical=true,push=true
          cache-from: type=gha,scope=\${{ matrix.svc.name }}-\${{ matrix.platform.arch }}
          cache-to: type=gha,mode=max,scope=\${{ matrix.svc.name }}-\${{ matrix.platform.arch }}
      - run: mkdir -p /tmp/digests && touch "/tmp/digests/\${DIGEST#sha256:}"
        env: { DIGEST: "\${{ steps.build.outputs.digest }}" }
      - uses: actions/upload-artifact@v4
        with: { name: "digests-\${{ matrix.svc.name }}-\${{ matrix.platform.arch }}", path: /tmp/digests/*, retention-days: 1 }

  merge:
    needs: build
    runs-on: ubuntu-latest
    strategy:
      matrix:
        svc: [${built.map(s => s.name).join(', ') || 'app'}]
    steps:
      - uses: actions/download-artifact@v4
        with: { pattern: "digests-\${{ matrix.svc }}-*", merge-multiple: true, path: /tmp/digests }
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ${reg.split('/')[0]}, username: \${{ github.actor }}, password: \${{ secrets.GITHUB_TOKEN }} }
      - working-directory: /tmp/digests
        run: |
          docker buildx imagetools create -t ${reg}/\${{ matrix.svc }}:\${{ github.sha }} \\
            $(printf '${reg}/\${{ matrix.svc }}@sha256:%s ' *)
          docker buildx imagetools inspect ${reg}/\${{ matrix.svc }}:\${{ github.sha }}
`
}

export function buildxCli(services: Service[], registry: string): string {
  const reg = registry.replace(/\/+$/, '') || 'ghcr.io/your-org'
  const built = services.filter(s => s.dockerfile)
  return `# One-off multi-arch build from a laptop (arm64 runs under QEMU on x86 hosts)
docker buildx create --name multiarch --use --bootstrap
${(built.length ? built : [{ name: 'app', dockerfile: 'Dockerfile' } as Service]).map(s => `docker buildx build --platform linux/amd64,linux/arm64 \\
  -f ${s.dockerfile} -t ${reg}/${s.name}:$(git rev-parse --short HEAD) --push ${dirOf(s.dockerfile!)}`).join('\n')}
# Verify both platforms are in the tag
docker buildx imagetools inspect ${reg}/${built[0]?.name ?? 'app'}:$(git rev-parse --short HEAD)
`
}

const dirOf = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'

export interface PatchOptions { mode: 'required' | 'preferred'; taintKey: string; taintValue: string }

/** Strategic-merge patches that move workloads onto arm64 nodes, plus the kustomization that applies them. */
export function k8sPatches(workloads: { name: string; kind: string }[], o: PatchOptions): { file: string; text: string }[] {
  const tol = o.taintKey ? `
      tolerations:
        - key: ${o.taintKey}
          operator: Equal
          value: "${o.taintValue}"
          effect: NoSchedule` : ''
  const sched = o.mode === 'required' ? `
      nodeSelector:
        kubernetes.io/arch: arm64` : `
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - { key: kubernetes.io/arch, operator: In, values: [arm64] }`
  const files = workloads.map(w => ({
    file: `arm64/${w.name}.patch.yaml`,
    text: `# Moves ${w.name} to arm64 nodes${o.mode === 'preferred' ? ' when available (falls back to amd64)' : ''}
apiVersion: apps/v1
kind: ${w.kind}
metadata:
  name: ${w.name}
spec:
  template:
    spec:${sched}${tol}
`,
  }))
  files.push({ file: 'arm64/kustomization.yaml', text: `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../base
patches:
${workloads.map(w => `  - path: ${w.name}.patch.yaml`).join('\n')}
` })
  return files
}

/** Workload kinds from K8s manifest text, so patches use the right kind. */
export function workloadKinds(text: string): { name: string; kind: string }[] {
  const out: { name: string; kind: string }[] = []
  for (const doc of text.split(/^---/m)) {
    const kind = doc.match(/^kind:\s*(\S+)/m)?.[1]
    const name = doc.match(/^metadata:\s*\n(?:\s+.*\n)*?\s{1,4}name:\s*["']?([^"'\s#]+)/m)?.[1]
    if (kind && name && /^(Deployment|StatefulSet|DaemonSet)$/.test(kind)) out.push({ name, kind })
  }
  return out
}
