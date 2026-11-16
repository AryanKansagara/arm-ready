# Arm Ready

An arm64 migration readiness scanner for containerised services. Drop in Dockerfiles, Compose or Kubernetes manifests and dependency lockfiles; Arm Ready checks every base image, downloaded binary and package for linux/arm64 against live public registries, flags blockers with file and line, writes the multi-arch CI and node patches, and estimates the cost change of moving to Graviton.

Live: https://arm-ready-gamma.vercel.app

## The pain

Platform teams moving EKS workloads from x86 (c5a, m5) to Graviton (c7g, c8g) keep hitting the same things: a third-party image with no arm64 tag, a Dockerfile that curls an amd64 tarball, a Python package without an aarch64 wheel, a Node native addon, a JNI jar with only x86 natives, CI that crawls under QEMU, and the open question of whether it is still cheaper once you size for performance.

## Features

- Import Dockerfiles, docker-compose, rendered Helm/K8s YAML, requirements.txt, poetry.lock, package-lock.json, go.mod, pom.xml, Gradle lists, Cargo.lock and an instance inventory CSV, with format detection, column mapping and a line-numbered validation report.
- Dockerfile parser: multi-stage FROM, ARG defaults, `--platform`, hard-coded amd64 downloads, `GOARCH`, `[arch=amd64]` apt sources, x86 library paths and compiler flags, apt/apk packages.
- Live checks: registry manifest lists (Docker Hub, GHCR, Quay, MCR, GCR and other public registries via a small `/api/manifest` function), PyPI wheel tags (glibc vs musl), npm install-script metadata. Curated notes for cgo, JNI and Rust `-sys` crates.
- Per-service readiness score, worklist with status tracking and CSV export, printable report.
- Generated GitHub Actions workflow (native `ubuntu-24.04-arm` runners or QEMU), buildx commands, nodeSelector/affinity patches with kustomization, and a `docker manifest inspect` export script for private registries.
- Cost model: the official AWS Linux on-demand price list for every instance type (us-east-1 bundled, 19 more regions loaded on demand through `/api/prices`), Graviton 7g/8g/9g targets that keep `d`/`n` variants, per-family price overrides, performance factor and break-even per node group.
- Scan history per repo with trend and compare view.
- Local-first (IndexedDB). Optional email/password sign-in syncs repos across devices.
- Synthetic sample repo (clearly labelled) with Python, Node native addons, Go cgo, Java JNI and an amd64-only vendor database.

## Tested against real files

The parsers are regression-tested with excerpts from public repos (`src/engine/real.test.ts`): GoogleCloudPlatform/microservices-demo (Dockerfiles, go.mod, package-lock.json, requirements.txt, build.gradle, Kubernetes manifests), apache/superset (Dockerfile, Compose), getsentry/self-hosted (Compose with anchors), puppeteer (Dockerfile), BurntSushi/ripgrep (Cargo.lock), spring-petclinic (pom.xml), python-poetry (poetry.lock) and the Argo CD install manifest.

Prices come from the JSON behind https://aws.amazon.com/ec2/pricing/on-demand/. Refresh the bundled us-east-1 table with `node scripts/refresh-prices.mjs`.

## Known gaps

- yarn.lock and pnpm-lock.yaml are not parsed; generate a package-lock.json for the scan.
- Helm charts must be rendered first; Compose images that are only a variable need the value filled in.
- Private registries are not queried from the browser; use the generated `docker manifest inspect` script and import its output.
- Only general purpose, compute, memory and burstable x86 families are mapped to Graviton automatically; other families need the Arm type entered per row.
- Prices are on-demand; Savings Plans and spot are modelled by overriding family prices.

## Run locally

```
npm install
npm run dev      # http://localhost:5173 (the manifest lookup function runs in the dev server too)
npm test         # engine tests
npm run build
```

Optional sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`.
