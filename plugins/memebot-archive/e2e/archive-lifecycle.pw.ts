import { expect, test } from '@playwright/test'

const webui = process.env.MEMEBOT_ARCHIVE_WEBUI_URL

test.skip(!webui, 'MEMEBOT_ARCHIVE_WEBUI_URL is required for the Archive WebUI test')

test('removes and restores a Paper through the WebUI with target confirmation', async ({ page }) => {
  const title = `Browser lifecycle ${Date.now()}`
  await page.goto('/memebot/archive')
  await expect(page.getByRole('heading', { name: '移除与恢复' })).toBeVisible()

  await page.getByRole('textbox', { name: '标题', exact: true }).fill(title)
  await page.getByRole('textbox', { name: '期号', exact: true }).fill('16')
  await page.getByRole('textbox', { name: '月份（YYYY-MM）' }).fill('2026-08')
  await page.locator('input[type="file"][accept="application/pdf,.pdf"]').setInputFiles('e2e/fixtures/paper.pdf')
  await page.getByRole('button', { name: '创建并上传' }).click()

  const activeRow = page.getByRole('row').filter({ hasText: title })
  await expect(activeRow).toBeVisible()
  const id = (await activeRow.innerText()).match(/P\d+/)?.[0]
  expect(id).toBeTruthy()

  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm')
    expect(dialog.message()).toContain(`${id} 2026-08 ${title}`)
    expect(dialog.message()).toContain('保留 30 天')
    await dialog.accept()
  })
  await activeRow.getByRole('button', { name: '移除' }).click()

  const removedRow = page.getByRole('row').filter({ hasText: title })
  await expect(removedRow).toContainText('删除：')
  await expect(removedRow).toContainText('到期：')

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain(`恢复 ${id} ${title}`)
    await dialog.accept()
  })
  await removedRow.getByRole('button', { name: '恢复' }).click()
  await expect(page.getByRole('row').filter({ hasText: title })).toContainText(id!)
})
