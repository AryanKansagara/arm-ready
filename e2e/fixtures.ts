import { expect, test as base, type Page, type Route } from '@playwright/test'

// Every test runs signed out, with all registry lookups stubbed and Supabase blocked.
// Anything else that leaves the preview server is aborted and fails the test.

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })

const MULTI = [{ os: 'linux', architecture: 'amd64' }, { os: 'linux', architecture: 'arm64' }]
const X86_ONLY = [{ os: 'linux', architecture: 'amd64' }]

/** Calls the stubs saw, so a test can assert that a lookup was (or was not) made. */
export interface Calls { images: string[]; pypi: string[]; npm: string[]; prices: string[] }

async function stub(page: Page, calls: Calls, violations: string[]) {
  await page.route(() => true, route => {
    const url = new URL(route.request().url())
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    if (local && url.pathname === '/api/manifest') {
      const ref = url.searchParams.get('ref') ?? ''
      calls.images.push(ref)
      // The one vendor image in the sample that has no arm64 build.
      return json(route, { ok: true, platforms: /mssql\/server/.test(ref) ? X86_ONLY : MULTI, source: 'stubbed registry' })
    }
    if (local && url.pathname === '/api/prices') {
      // The app falls back to its bundled us-east-1 table when the live list is unavailable.
      calls.prices.push(url.searchParams.get('region') ?? '')
      return json(route, { ok: false, error: 'stubbed' })
    }
    if (local) return route.continue()
    if (url.hostname === 'pypi.org') {
      const name = decodeURIComponent(url.pathname.split('/')[2] ?? '')
      calls.pypi.push(name)
      // mysqlclient only publishes a source archive; everything else has a universal wheel.
      const files = name === 'mysqlclient' ? [{ filename: `${name}-1.0.tar.gz`, packagetype: 'sdist' }] : [{ filename: `${name}-1.0-py3-none-any.whl`, packagetype: 'bdist_wheel' }]
      return json(route, { info: { version: '1.0' }, urls: files })
    }
    if (url.hostname === 'registry.npmjs.org') {
      const name = decodeURIComponent(url.pathname.slice(1).split('/').slice(0, -1).join('/'))
      calls.npm.push(name)
      return json(route, { name, version: '1.0.0', scripts: { install: 'node-gyp rebuild' }, gypfile: true })
    }
    // Web fonts: answered with an empty stylesheet so the page renders in its fallback fonts, offline.
    if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
    if (url.hostname === 'fonts.gstatic.com') return route.fulfill({ status: 200, contentType: 'font/woff2', body: '' })
    if (/(^|\.)supabase\.(co|in)$/.test(url.hostname)) return route.abort()
    violations.push(`blocked ${route.request().method()} ${url.origin}${url.pathname}`)
    return route.abort()
  })
}

export const test = base.extend<{ calls: Calls; violations: string[]; pageErrors: Error[] }>({
  calls: async ({}, use) => { await use({ images: [], pypi: [], npm: [], prices: [] }) },
  violations: async ({}, use) => { await use([]) },
  pageErrors: async ({}, use) => { await use([]) },
  page: async ({ page, calls, violations, pageErrors }, use) => {
    page.on('pageerror', e => pageErrors.push(e))
    await stub(page, calls, violations)
    await use(page)
    expect(violations, 'requests that were not stubbed').toEqual([])
    expect(pageErrors, 'uncaught page errors').toEqual([])
  },
})

export { expect }

/** Creates an empty repo through the UI and lands on its Files tab. */
export async function newRepo(page: Page, name: string) {
  await page.goto('/app')
  await page.getByRole('button', { name: 'New repo scan' }).click()
  await page.getByLabel('Repo or platform name').fill(name)
  await page.getByRole('button', { name: 'Create and import' }).click()
  await expect(page).toHaveURL(/\/app\/p\/[\w-]+\/files/)
}
