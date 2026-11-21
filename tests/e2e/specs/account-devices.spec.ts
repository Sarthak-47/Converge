import { expect, test } from '@playwright/test'
import { register, signIn, uniqueEmail } from './helpers.ts'

/** Signed-in devices: a person sees where they are signed in and signs another device out. */
test('signing another device out ends its session there', async ({ page, browser }) => {
  const email = uniqueEmail('devices')
  await register(page, email, 'Devi')

  const other = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' })
  const phone = await other.newPage()
  await signIn(phone, email)

  await page.getByRole('button', { name: 'Signed-in devices' }).click()
  const devices = page.getByLabel('Devices')
  await expect(devices.getByRole('listitem')).toHaveCount(2)
  await expect(devices.getByRole('listitem').first()).toContainText('This device')
  await devices.getByRole('button', { name: 'Sign out Safari on iOS' }).click()
  await expect(devices.getByRole('listitem')).toHaveCount(1)
  await expect(page.getByRole('dialog')).toContainText('You are signed in only here.')

  // The phone is signed out on its next request; this browser is not.
  await phone.reload()
  await expect(phone.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible()
  await other.close()
})
