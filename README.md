# Arm Ready

An arm64 migration readiness scanner for containerised services. Drop in Dockerfiles, Compose or Kubernetes manifests and dependency lockfiles; Arm Ready checks every base image, downloaded binary and package for linux/arm64 against live public registries, flags blockers with file and line, writes the multi-arch CI and node patches, and estimates the cost change of moving to Graviton.

Live: https://arm-ready-gamma.vercel.app

## The pain

Platform teams moving EKS workloads from x86 (c5a, m5) to Graviton (c7g, c8g) keep hitting the same things: a third-party image with no arm64 tag, a Dockerfile that curls an amd64 tarball, a Python package without an aarch64 wheel, a Node native addon, a JNI jar with only x86 natives, CI that crawls under QEMU, and the open question of whether it is still cheaper once you size for performance.

## Features

- Import Dockerfiles, docker-compose, rendered Helm/K8s YAML, requirements.txt, poetry.lock, package-lock.json, yarn.lock (Yarn 1 and 2+), pnpm-lock.yaml (v9 and v6), go.mod, pom.xml, Gradle lists, Cargo.lock and an instance inventory CSV, with format detection, column mapping and a line-numbered validation report.
- Dockerfile parser: multi-stage FROM, ARG defaults, `--platform`, hard-coded amd64 downloads, `GOARCH`, `[arch=amd64]` apt sources, x86 library paths and compiler flags, apt/apk packages.
- Live checks: registry manifest lists (Docker Hub, GHCR, Quay, MCR, GCR and other public registries via a small `/api/manifest` function), PyPI wheel tags (glibc vs musl), npm install-script metadata. Curated notes for cgo, JNI and Rust `-sys` crates.
- Per-service readiness score, worklist with status tracking and CSV export, printable report.
- Generated GitHub Actions workflow (native `ubuntu-24.04-arm` runners or QEMU), buildx commands, nodeSelector/affinity patches with kustomization, and a `docker manifest inspect` export script for private registries.
- Cost model: the official AWS Linux on-demand price list for every instance type (us-east-1 bundled, 19 more regions loaded on demand through `/api/prices`), Graviton 7g/8g/9g targets that keep `d`/`n` variants, per-family price overrides, performance factor and break-even per node group.
- Scan history per repo with trend and compare view.
- Local-first (IndexedDB). Optional email/password sign-in syncs repos across devices.
- Synthetic sample repo (clearly labelled) with Python, Node native addons, Go cgo, Java JNI and an amd64-only vendor database.

## Tested against real files

The parsers are regression-tested with excerpts from public repos (`src/engine/real.test.ts`): GoogleCloudPlatform/microservices-demo (Dockerfiles, go.mod, package-lock.json, requirements.txt, build.gradle, Kubernetes manifests), apache/superset (Dockerfile, Compose), getsentry/self-hosted (Compose with anchors), puppeteer (Dockerfile), BurntSushi/ripgrep (Cargo.lock), spring-petclinic (pom.xml), python-poetry (poetry.lock) and the Argo CD install manifest. Yarn and pnpm lockfiles (`src/engine/lockfiles.test.ts`) use excerpts of facebook/react, firebase-js-sdk, babel, yarnpkg/berry (lockfile versions 4, 6, 8 and 10), vitejs/vite (pnpm 6 and 9, including a two-document file) and withastro/astro; the sources and commits are named at the top of that file. Platform-specific packages (`src/engine/platform.test.ts`) use excerpts of microsoft/playwright (package-lock.json), yarnpkg/berry and storybookjs/storybook (Yarn Berry, including packages installed under aliases), vitejs/vite and tailwindlabs/tailwindcss (pnpm 9); the sources and commits are named at the top of that file.

Prices come from the JSON behind https://aws.amazon.com/ec2/pricing/on-demand/. Refresh the bundled us-east-1 table with `node scripts/refresh-prices.mjs`.

## Known gaps

- Packages built for one platform (`os`, `cpu`, `libc` in package-lock.json and pnpm-lock.yaml, `conditions` in Yarn 2+ lockfiles) are judged for linux/arm64: fine when the lockfile has the arm64 counterpart (`esbuild`, `sharp`, `@rollup/*`), a blocker when required without one, a warning when optional or dev-only, unverified when the lockfile does not say whether they are optional. The counterpart is found through the parent's optional dependencies, or by `x64` to `arm64` in the name. Yarn 1 does not record `os` or `cpu`, so x64-only packages are not detected in yarn.lock v1; the file says so.
- A lockfile that cannot be read (merge conflict markers, tab or odd indentation, entries without a version or resolution, a pnpm file with dependencies but no packages, a package-lock.json without a packages map) is an error plus an unverified item, never ready. `poetry.lock`, `Cargo.lock`, `go.mod` and the Java files still report an unreadable file as a file error only.

- yarn.lock (Yarn 1, and Yarn 2+ metadata versions 4 to 10) and pnpm-lock.yaml (lockfileVersion 9.x and 6.x) do not record install scripts, so at most 100 packages per scan are looked up on npm (packages that depend on a native-build helper first) and the rest are reported as not checked, never as pure JavaScript. Other lockfile versions are an error. Git, tarball and other non-registry entries are listed as unknown; workspace, link, portal and file entries are skipped. `bun.lock` is not read, and versions are never resolved from `package.json` ranges.
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
npm run test:e2e # builds, serves the production build with vite preview and runs the browser tests
```

The end-to-end tests use Playwright with Chromium. Install the browser once with `npx playwright install chromium` (add `--with-deps` on a fresh Linux machine). They run signed out, answer every registry and price lookup from stubs, block Supabase, and fail on any other network request or uncaught page error. The preview server uses port 4179; set `E2E_PORT` to change it. The same steps run in GitHub Actions on every pull request and push to `main` ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

Optional sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`.
