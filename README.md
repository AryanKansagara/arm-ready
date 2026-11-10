# Arm Ready

An arm64 migration readiness scanner for containerised services. Drop in Dockerfiles, Compose or Kubernetes manifests and dependency lockfiles; Arm Ready checks every base image, downloaded binary and package for linux/arm64 against live public registries, flags blockers with file and line, writes the multi-arch CI and node patches, and estimates the cost change of moving to Graviton.

Live: https://arm-ready.vercel.app

## The pain

Platform teams moving EKS workloads from x86 (c5a, m5) to Graviton (c7g, c8g) keep hitting the same things: a third-party image with no arm64 tag, a Dockerfile that curls an amd64 tarball, a Python package without an aarch64 wheel, a Node native addon, a JNI jar with only x86 natives, CI that crawls under QEMU, and the open question of whether it is still cheaper once you size for performance.

## Features

- Import Dockerfiles, docker-compose, rendered Helm/K8s YAML, requirements.txt, poetry.lock, package-lock.json, go.mod, pom.xml, Gradle lists, Cargo.lock and an instance inventory CSV, with format detection, column mapping and a line-numbered validation report.
- Dockerfile parser: multi-stage FROM, ARG defaults, `--platform`, hard-coded amd64 downloads, `GOARCH`, `[arch=amd64]` apt sources, x86 library paths and compiler flags, apt/apk packages.
- Live checks: registry manifest lists (Docker Hub, GHCR, Quay, MCR, GCR and other public registries via a small `/api/manifest` function), PyPI wheel tags (glibc vs musl), npm install-script metadata. Curated notes for cgo, JNI and Rust `-sys` crates.
- Per-service readiness score, worklist with status tracking and CSV export, printable report.
- Generated GitHub Actions workflow (native `ubuntu-24.04-arm` runners or QEMU), buildx commands, nodeSelector/affinity patches with kustomization, and a `docker manifest inspect` export script for private registries.
- Cost model: dated, editable on-demand price table, Graviton3/4 targets, performance factor and break-even per node group.
- Scan history per repo with trend and compare view.
- Local-first (IndexedDB). Optional email/password sign-in syncs repos across devices.
- Synthetic sample repo (clearly labelled) with Python, Node native addons, Go cgo, Java JNI and an amd64-only vendor database.

## Run locally

```
npm install
npm run dev      # http://localhost:5173 (the manifest lookup function runs in the dev server too)
npm test         # engine tests
npm run build
```

Optional sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`.
