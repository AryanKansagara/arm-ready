import { expect, newRepo, test } from './fixtures'

const dockerfile = (name = 'Dockerfile') => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from([
    'FROM python:3.12-slim',
    'RUN apt-get update && apt-get install -y curl',
    'RUN curl -fsSL https://example.com/releases/tool-linux-amd64.tar.gz | tar -xz -C /usr/local/bin',
    '',
  ].join('\n')),
})

test('sample repo shows readiness scores and blockers with file and line', async ({ page, calls }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the sample scan' }).first().click()
  await expect(page).toHaveURL(/\/app\/p\/[\w-]+/)
  await expect(page.getByRole('heading', { level: 1, name: /shopfront/ })).toBeVisible()
  await expect(page.getByText(/Scan finished: readiness \d+/)).toBeVisible({ timeout: 30_000 })

  // Overview: repo score, per-service scores and the top blockers.
  await expect(page.getByRole('img', { name: /^Readiness \d+ of 100$/ }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible()
  await expect(page.locator('.svc-grid .svc').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Top blockers' })).toBeVisible()
  await expect(page.locator('.diff-list .where').first()).toHaveText(/\S+:\d+$/)

  // Worklist: the amd64 ffmpeg download on line 7 of the api Dockerfile, and the GOARCH pin in the worker.
  await page.getByRole('link', { name: /^Worklist/ }).click()
  const ffmpeg = page.getByRole('row').filter({ hasText: 'ffmpeg-release-amd64-static.tar.xz' })
  await expect(ffmpeg).toContainText('Downloads an amd64 binary')
  await expect(ffmpeg.locator('.where')).toHaveText('api · binary · services/api/Dockerfile:7')
  await expect(page.getByRole('row').filter({ hasText: 'Go build hard-codes GOARCH' }).locator('.where')).toHaveText(/services\/worker\/Dockerfile:\d+$/)
  await expect(page.getByRole('row').filter({ hasText: 'No linux/arm64 image' }).first()).toBeVisible()

  // Every lookup came from the stubs.
  expect(calls.images.length).toBeGreaterThan(0)
  expect(calls.pypi).toContain('mysqlclient')
})

test('worklist status can be updated and survives a reload', async ({ page }) => {
  await page.goto('/app?sample=1&tab=worklist')
  await expect(page.getByText(/Scan finished/)).toBeVisible({ timeout: 30_000 })

  const row = () => page.getByRole('row').filter({ hasText: 'ffmpeg-release-amd64-static.tar.xz' })
  await expect(page.getByText(/^0 of \d+ items closed/)).toBeVisible()
  await row().getByRole('combobox', { name: /^Status for/ }).selectOption('done')
  await expect(page.getByText(/^1 of \d+ items closed/)).toBeVisible()

  await page.reload()
  await expect(row().getByRole('combobox', { name: /^Status for/ })).toHaveValue('done')
  await expect(page.getByText(/^1 of \d+ items closed/)).toBeVisible()

  await row().getByRole('combobox', { name: /^Status for/ }).selectOption('doing')
  await expect(page.getByText(/^0 of \d+ items closed/)).toBeVisible()
})

test('imported Dockerfile with a hard-coded amd64 download is flagged and kept after a reload', async ({ page }) => {
  await newRepo(page, 'e2e-platform')
  await page.locator('input[type=file]').first().setInputFiles(dockerfile())

  const review = page.getByRole('dialog', { name: 'Review import' })
  await expect(review.getByRole('row', { name: /Dockerfile\s+Dockerfile/ })).toBeVisible()
  await review.getByRole('button', { name: 'Import' }).click()
  await expect(page.getByText('Imported 1 file.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Validation report' })).toBeVisible()

  await page.getByRole('button', { name: 'Scan 1 files' }).click()
  await expect(page.getByText(/Scan finished: readiness \d+, 1 blockers/)).toBeVisible({ timeout: 30_000 })

  await page.getByRole('link', { name: /^Worklist/ }).click()
  const row = page.getByRole('row').filter({ hasText: 'Downloads an amd64 binary' })
  await expect(row).toContainText('tool-linux-amd64.tar.gz')
  await expect(row.locator('.where')).toHaveText('root · binary · Dockerfile:3')
  await expect(row).toContainText('ARG TARGETARCH')

  // The repo, its file and its findings are still there after a reload and on the repo list.
  await page.reload()
  await expect(row).toBeVisible()
  await page.goto('/app')
  const card = page.locator('.proj', { hasText: 'e2e-platform' })
  await expect(card).toContainText('1 files')
  await expect(card).toContainText('1 blockers')
})

test('pasted text is detected and flagged the same way', async ({ page }) => {
  await newRepo(page, 'e2e-paste')
  await page.getByRole('button', { name: 'Paste text' }).click()
  const paste = page.getByRole('dialog', { name: 'Paste a file' })
  await paste.getByLabel(/^Path/).fill('services/api/Dockerfile')
  await paste.getByLabel('Contents').fill((dockerfile().buffer).toString())
  await expect(paste.getByText('Detected:')).toContainText('Dockerfile')
  await paste.getByRole('button', { name: 'Review' }).click()
  await page.getByRole('dialog', { name: 'Review import' }).getByRole('button', { name: 'Import' }).click()
  await page.getByRole('button', { name: 'Scan 1 files' }).click()
  await expect(page.getByText(/Scan finished/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('link', { name: /^Worklist/ }).click()
  await expect(page.getByRole('row').filter({ hasText: 'Downloads an amd64 binary' }).locator('.where')).toHaveText('api · binary · services/api/Dockerfile:3')
})

test('wrong-format and unreadable files give a message and the app stays usable', async ({ page }) => {
  await newRepo(page, 'e2e-bad-files')
  const input = page.locator('input[type=file]').first()
  const review = page.getByRole('dialog', { name: 'Review import' })
  const cancel = async () => {
    await review.getByRole('button', { name: 'Cancel' }).click()
    await expect(review).toBeHidden()
    // The dialog's native close event is delivered a moment after it hides; let it land before the next import.
    await page.evaluate(() => new Promise(r => setTimeout(r, 100)))
  }

  // A lockfile that is not JSON: the error names the line.
  await input.setInputFiles({ name: 'package-lock.json', mimeType: 'application/json', buffer: Buffer.from('{\n  "name": "x",\n  "packages": {,\n}\n') })
  await expect(review.getByText(/Not valid JSON/)).toBeVisible()
  await expect(review.getByText(/^line \d+$/).first()).toBeVisible()
  await expect(review.getByText(/1 file error; those files are imported but contribute nothing/)).toBeVisible()
  await cancel()

  // A lockfile from an old npm that has no "packages" map.
  await input.setInputFiles({ name: 'package-lock.json', mimeType: 'application/json', buffer: Buffer.from('{ "name": "x", "lockfileVersion": 1, "dependencies": {} }') })
  await expect(review.getByText(/has no "packages" map/)).toBeVisible()
  await cancel()

  // A file in a format the scanner does not read cannot be imported.
  await input.setInputFiles({ name: 'notes.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 3]) })
  await expect(review.getByText(/Skipped \(format not recognised\): notes\.bin/)).toBeVisible()
  await expect(review.getByRole('button', { name: 'Import' })).toBeDisabled()
  await cancel()

  // A file over 8 MB is skipped with a message.
  await input.setInputFiles({ name: 'Dockerfile', mimeType: 'text/plain', buffer: Buffer.alloc(8_000_001, 'a') })
  await expect(page.getByText('Dockerfile is over 8 MB and was skipped.')).toBeVisible()
  await expect(page.getByText('No Dockerfiles, manifests or lockfiles found in that selection.')).toBeVisible()
  await expect(review).toBeHidden()

  // Nothing was imported, and a valid file still goes through afterwards.
  await expect(page.getByRole('heading', { name: 'Validation report' })).toHaveCount(0)
  await input.setInputFiles(dockerfile())
  await review.getByRole('button', { name: 'Import' }).click()
  await expect(page.getByText('Imported 1 file.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Validation report' })).toBeVisible()
})

test('signed out: Supabase is blocked and the app keeps working', async ({ page }) => {
  const supabase: string[] = []
  page.on('requestfailed', r => { if (/supabase\.(co|in)/.test(r.url())) supabase.push(r.url()) })
  await page.goto('/app')
  await expect(page.getByRole('button', { name: 'Sign in to sync' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Repos', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try the sample' })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('sb-')))).toEqual([])

  // A request to a Supabase host fails instead of reaching the network; nothing in the app depends on it.
  const reachable = await page.evaluate(() => fetch('https://example.supabase.co/auth/v1/health').then(() => true, () => false))
  expect(reachable).toBe(false)
  expect(supabase).toHaveLength(1)

  await page.getByRole('button', { name: 'Try the sample' }).click()
  await expect(page.getByText(/Scan finished/)).toBeVisible({ timeout: 30_000 })
})
