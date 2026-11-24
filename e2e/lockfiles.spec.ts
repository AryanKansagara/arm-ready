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
