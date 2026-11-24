import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, newRepo, test } from './fixtures'

// Excerpts of real public lockfiles (sources and commits are named in src/engine/lockfiles.test.ts).
// npm lookups are stubbed: nan and node-addon-api compile with node-gyp, everything else has no install script.
const fixture = (name: string) => readFileSync(join(process.cwd(), 'src/engine/fixtures', name))

const FORMATS = [
  { title: 'Yarn 1', file: 'yarn.lock', fixture: 'yarn-v1.react.lock', native: 'nan', nativeLine: 54, nativeVersion: 'nan@2.14.1', local: /1 local entries/, asked: '@typescript-eslint/parser@5.62.0' },
  { title: 'Yarn Berry v10', file: 'yarn.lock', fixture: 'yarn-berry-v10.babel.lock', native: null, nativeLine: 0, nativeVersion: '', local: /2 local entries/, asked: 'string-width@4.2.3' },
  { title: 'pnpm 9', file: 'pnpm-lock.yaml', fixture: 'pnpm-v9.vite.yaml', native: 'node-addon-api', nativeLine: 91, nativeVersion: 'node-addon-api@7.1.1', local: /1 local entries/, asked: 'obug@1.0.2' },
  { title: 'pnpm 6', file: 'pnpm-lock.yaml', fixture: 'pnpm-v6.vite.yaml', native: null, nativeLine: 0, nativeVersion: '', local: /1 local entries/, asked: '@babel/highlight@7.22.13' },
] as const

for (const f of FORMATS) {
  test(`${f.title}: import, review, scan with stubbed npm lookups`, async ({ page, calls }) => {
    await newRepo(page, `e2e-${f.title.toLowerCase().replace(/\W+/g, '-')}`)
    await page.locator('input[type=file]').first().setInputFiles({ name: f.file, mimeType: 'text/plain', buffer: fixture(f.fixture) })

    // The review names the format and reports local entries; there is no error.
    const review = page.getByRole('dialog', { name: 'Review import' })
    const row = review.getByRole('row', { name: new RegExp(`^${f.file.replace('.', '\\.')}`) })
    await expect(row).toContainText(f.file)
    await expect(row.getByRole('cell', { name: f.file, exact: true })).toBeVisible()
    await expect(review.getByText(f.local)).toBeVisible()
    await expect(review.getByText(/file error/)).toHaveCount(0)
    await review.getByRole('button', { name: 'Import' }).click()
    await expect(page.getByText('Imported 1 file.')).toBeVisible()

    await page.getByRole('button', { name: 'Scan 1 files' }).click()
    await expect(page.getByText(/Scan finished: readiness \d+/)).toBeVisible({ timeout: 30_000 })

    // Lookups carry the locked version, once per name@version, never more than the cap, and aliases ask for the real package.
    expect(calls.npmVersions.length).toBeGreaterThan(0)
    expect(calls.npmVersions.length).toBeLessThanOrEqual(100)
    expect(new Set(calls.npmVersions).size).toBe(calls.npmVersions.length)
    expect(calls.npmVersions).toContain(f.asked)
    if (f.nativeVersion) expect(calls.npmVersions).toContain(f.nativeVersion)

    // A native-build dependency lands on the worklist at its lockfile line.
    await page.getByRole('link', { name: /^Worklist/ }).click()
    if (f.native) {
      const native = page.getByRole('row').filter({ hasText: 'Compiles a native addon with node-gyp' }).filter({ hasText: f.native })
      await expect(native.first().locator('.where')).toHaveText(new RegExp(`^root · npm · ${f.file.replace('.', '\\.')}:${f.nativeLine}$`))
    }
  })
}

test('lockfiles from Yarn and pnpm are also detected from pasted text', async ({ page }) => {
  await newRepo(page, 'e2e-paste-lock')
  await page.getByRole('button', { name: 'Paste text' }).click()
  const paste = page.getByRole('dialog', { name: 'Paste a file' })
  await paste.getByLabel('Contents').fill(fixture('yarn-berry-v10.babel.lock').toString())
  await expect(paste.getByText('Detected:')).toContainText('yarn.lock')
  await paste.getByLabel('Contents').fill(fixture('pnpm-v9.vite.yaml').toString())
  await expect(paste.getByText('Detected:')).toContainText('pnpm-lock.yaml')
})

test('unsupported lockfile versions are an error with the line, and the service is not ready', async ({ page, calls }) => {
  await newRepo(page, 'e2e-unsupported-lock')
  const input = page.locator('input[type=file]').first()
  const review = page.getByRole('dialog', { name: 'Review import' })

  // pnpm 13.0 (experimental format) and a Yarn Berry file whose metadata version is newer than the parser knows.
  await input.setInputFiles([
    { name: 'pnpm-lock.yaml', mimeType: 'text/plain', buffer: fixture('pnpm-v13.pnpm.yaml') },
    { name: 'yarn.lock', mimeType: 'text/plain', buffer: Buffer.from(fixture('yarn-berry-v8.lock').toString().replace('  version: 8\n', '  version: 11\n')) },
  ])
  await expect(review.getByText(/lockfileVersion 13\.0 is not supported/)).toBeVisible()
  await expect(review.getByText(/__metadata version 11 is not supported/)).toBeVisible()
  await expect(review.getByText('line 16', { exact: true })).toBeVisible() // lockfileVersion in the pnpm file
  await expect(review.getByText('line 4', { exact: true })).toBeVisible() // __metadata in the Yarn file
  await expect(review.getByText(/2 file errors; those files are imported but contribute nothing until fixed/)).toBeVisible()
  await review.getByRole('button', { name: 'Import' }).click()
  await expect(page.getByText('Imported 2 files.')).toBeVisible()

  await page.getByRole('button', { name: 'Scan 2 files' }).click()
  await expect(page.getByText(/Scan finished/)).toBeVisible({ timeout: 30_000 })
  // Nothing was looked up, and the unreadable files show up as unknowns rather than an empty, ready-looking result.
  expect(calls.npm).toEqual([])
  await page.getByRole('link', { name: /^Overview/ }).click()
  await expect(page.locator('.svc-grid .svc').first()).toContainText('Needs work')
  await expect(page.locator('.svc-grid .svc').first()).not.toContainText('Ready for arm64')
  await page.getByRole('link', { name: /^Worklist/ }).click()
  await expect(page.getByRole('row').filter({ hasText: 'Lockfile could not be read' })).toHaveCount(2)
})

// A lockfile whose only package at risk is built for x64 Linux: sample data, nothing from a real project.
const X64_ONLY_LOCK = JSON.stringify({
  name: 'orders-api', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'orders-api', version: '1.0.0', dependencies: { express: '^4.19.2', 'acme-engine-linux-x64': '^2.1.0' } },
    'node_modules/express': { version: '4.19.2' },
    'node_modules/acme-engine-linux-x64': { version: '2.1.0', cpu: ['x64'], os: ['linux'] },
  },
}, null, 2)

test('an x64-only package in package-lock.json is a blocker on its line, not a ready service', async ({ page }) => {
  await newRepo(page, 'e2e-x64-only-lock')
  await page.locator('input[type=file]').first().setInputFiles({ name: 'package-lock.json', mimeType: 'application/json', buffer: Buffer.from(X64_ONLY_LOCK) })

  const line = X64_ONLY_LOCK.split('\n').findIndex(l => l.startsWith('    "node_modules/acme-engine-linux-x64"')) + 1
  const review = page.getByRole('dialog', { name: 'Review import' })
  await expect(review.getByText(/acme-engine-linux-x64@2\.1\.0 is required but supports only x64 on Linux/)).toBeVisible()
  await expect(review.getByText(`line ${line}`, { exact: true })).toBeVisible()
  await review.getByRole('button', { name: 'Import' }).click()
  await expect(page.getByText('Imported 1 file.')).toBeVisible()

  await page.getByRole('button', { name: 'Scan 1 files' }).click()
  await expect(page.getByText(/Scan finished: readiness \d+/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('link', { name: /^Overview/ }).click()
  await expect(page.locator('.svc-grid .svc').first()).toContainText('Blocked')
  await expect(page.locator('.svc-grid .svc').first()).not.toContainText('Ready for arm64')

  await page.getByRole('link', { name: /^Worklist/ }).click()
  const row = page.getByRole('row').filter({ hasText: 'Required package has no linux/arm64 build' })
  await expect(row).toContainText('acme-engine-linux-x64')
  await expect(row.locator('.where')).toHaveText(`root · npm · package-lock.json:${line}`)
})

// Excerpts of real lockfiles (sources in src/engine/platform.test.ts): every platform package has its arm64 counterpart.
for (const f of [
  { title: 'package-lock.json (playwright: esbuild, rolldown, fsevents)', file: 'package-lock.json', fixture: 'package-lock.esbuild-rolldown.playwright.json' },
  { title: 'pnpm 9 (vite: esbuild, rollup)', file: 'pnpm-lock.yaml', fixture: 'pnpm-v9.esbuild-rollup-family.vite.yaml' },
  { title: 'pnpm 9 (tailwindcss: platform builds as direct dependencies)', file: 'pnpm-lock.yaml', fixture: 'pnpm-v9.direct-platform-deps.tailwindcss.yaml' },
  { title: 'Yarn Berry v8 (berry: esbuild 0.15)', file: 'yarn.lock', fixture: 'yarn-berry-v8.esbuild-family.lock' },
  { title: 'Yarn Berry v10 (storybook: platform builds installed under aliases)', file: 'yarn.lock', fixture: 'yarn-berry-v10.codex-alias.storybook.lock' },
] as const) {
  test(`platform packages with an arm64 counterpart are not blockers: ${f.title}`, async ({ page }) => {
    await newRepo(page, `e2e-family-${f.fixture.replace(/\W+/g, '-').slice(0, 30)}`)
    await page.locator('input[type=file]').first().setInputFiles({ name: f.file, mimeType: 'text/plain', buffer: fixture(f.fixture) })
    const review = page.getByRole('dialog', { name: 'Review import' })
    await expect(review.getByRole('row', { name: new RegExp(`^${f.file.replace('.', '\\.')}`) })).toBeVisible()
    await expect(review.getByText(/file error/)).toHaveCount(0)
    await review.getByRole('button', { name: 'Import' }).click()
    await expect(page.getByText('Imported 1 file.')).toBeVisible()
    await page.getByRole('button', { name: 'Scan 1 files' }).click()
    await expect(page.getByText(/Scan finished: readiness \d+/)).toBeVisible({ timeout: 30_000 })

    await page.getByRole('link', { name: /^Overview/ }).click()
    await expect(page.locator('.svc-grid .svc').first()).not.toContainText('Blocked')
    await page.getByRole('link', { name: /^Worklist/ }).click()
    await expect(page.getByRole('row').filter({ hasText: /no linux\/arm64 build|skipped on arm64|optional or required is not recorded/ })).toHaveCount(0)
  })
}

test('unreadable lockfiles (merge conflict, wrong indentation) are an error on the line and a service that is not ready', async ({ page }) => {
  await newRepo(page, 'e2e-unreadable-lock')
  const input = page.locator('input[type=file]').first()
  const review = page.getByRole('dialog', { name: 'Review import' })

  await input.setInputFiles([
    { name: 'yarn.lock', mimeType: 'text/plain', buffer: Buffer.from('# yarn lockfile v1\n\n<<<<<<< HEAD\nsharp@^0.30.0:\n  version "0.30.0"\n=======\n') },
    { name: 'pnpm-lock.yaml', mimeType: 'text/plain', buffer: Buffer.from("lockfileVersion: '9.0'\n\npackages:\n    sharp@0.30.0:\n        resolution: {integrity: sha512-x}\n") },
  ])
  await expect(review.getByText(/Unresolved merge conflict markers at line 3/)).toBeVisible()
  await expect(review.getByText(/Line 4 is not in the layout pnpm writes/)).toBeVisible()
  await expect(review.getByText('line 3', { exact: true })).toBeVisible()
  await expect(review.getByText('line 4', { exact: true })).toBeVisible()
  await expect(review.getByText(/2 file errors; those files are imported but contribute nothing until fixed/)).toBeVisible()
  await review.getByRole('button', { name: 'Import' }).click()
  await expect(page.getByText('Imported 2 files.')).toBeVisible()

  await page.getByRole('button', { name: 'Scan 2 files' }).click()
  await expect(page.getByText(/Scan finished/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('link', { name: /^Overview/ }).click()
  await expect(page.locator('.svc-grid .svc').first()).toContainText('Needs work')
  await expect(page.locator('.svc-grid .svc').first()).not.toContainText('Ready for arm64')
  await page.getByRole('link', { name: /^Worklist/ }).click()
  const rows = page.getByRole('row').filter({ hasText: 'Lockfile could not be read' })
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: 'yarn.lock:3' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'pnpm-lock.yaml:4' })).toHaveCount(1)
})

test('a lockfile for a project without dependencies is valid and ready', async ({ page }) => {
  await newRepo(page, 'e2e-empty-lock')
  await page.locator('input[type=file]').first().setInputFiles({ name: 'package-lock.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ name: 'empty', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'empty', version: '1.0.0' } } }, null, 2)) })
  const review = page.getByRole('dialog', { name: 'Review import' })
  await expect(review.getByText(/This lockfile lists no dependencies/)).toBeVisible()
  await expect(review.getByText(/file error/)).toHaveCount(0)
  await review.getByRole('button', { name: 'Import' }).click()
  await page.getByRole('button', { name: 'Scan 1 files' }).click()
  await expect(page.getByText(/Scan finished/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('link', { name: /^Overview/ }).click()
  await expect(page.locator('.svc-grid .svc').first()).toContainText('Ready for arm64')
})
