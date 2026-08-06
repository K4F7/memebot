import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'

const fixtureRoot = resolve(__dirname, 'fixtures')
const runLabel = `Browser acceptance ${randomUUID()}`
const paperTitle = `${runLabel} Paper`
const workTitle = `${runLabel} Work`
const authMode = process.env.MEMEBOT_ARCHIVE_AUTH_MODE ?? 'absent'
const r2RecoveryAvailable = process.env.MEMEBOT_ARCHIVE_R2_RECOVERY === 'available'
const backupRetryAvailable = process.env.MEMEBOT_ARCHIVE_BACKUP_RETRY === 'available'

function crc32(data: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zipEntry(filename: string, content: string) {
  const name = Buffer.from(filename)
  const raw = Buffer.from(content)
  const compressed = deflateRawSync(raw)
  const crc = crc32(raw)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(raw.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt16LE(0x031e, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(raw.length, 24)
  central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + compressed.length, 16)
  return Buffer.concat([local, name, compressed, central, name, end])
}

async function expectNoHorizontalScroll(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
}

async function openArchiveTab(page: Page, name: string) {
  await page.getByRole('tab', { name }).click()
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
}

test.describe('Archive Console real-browser acceptance', () => {
  test('runs the complete local management surface', async ({ page }, testInfo) => {
    testInfo.annotations.push({ type: 'capability', description: 'Local storage, PDF, ZIP preview, Publication Appearance, lifecycle, navigation, keyboard and focus paths executed.' })
    const workPackage = testInfo.outputPath('browser-work.zip')
    await writeFile(workPackage, zipEntry('README.txt', 'Archive browser acceptance preview.'))

    await page.goto('/memebot/archive?tab=ops')
    await expect(page.getByRole('heading', { name: '运维' })).toBeVisible()
    await expect(page.getByText('可读写，诊断校验通过')).toBeVisible()
    await expect(page.getByText('未启用；远端备份与恢复不可用')).toBeVisible()

    await openArchiveTab(page, '报纸期数')
    await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('issues')
    await page.goBack()
    await expect(page.getByRole('tab', { name: '运维' })).toHaveAttribute('aria-selected', 'true')
    await page.goForward()
    await expect(page.getByRole('tab', { name: '报纸期数' })).toHaveAttribute('aria-selected', 'true')
    await page.reload()
    await expect(page.getByRole('heading', { name: '报纸期数' })).toBeVisible()

    const createPaper = page.getByRole('button', { name: '创建 Newspaper Issue' })
    await createPaper.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(createPaper).toBeFocused()
    await createPaper.click()
    const paperDialog = page.getByRole('dialog', { name: '创建 Newspaper Issue' })
    await paperDialog.getByRole('textbox', { name: /出刊月份/ }).fill('2026-08')
    await paperDialog.getByRole('textbox', { name: /期号/ }).fill('41')
    await paperDialog.getByRole('textbox', { name: /标题/ }).fill(paperTitle)
    await paperDialog.locator('input[type="file"]').setInputFiles(resolve(fixtureRoot, 'paper.pdf'))
    await paperDialog.getByRole('button', { name: '创建并上传' }).click()
    await expect(paperDialog).toBeHidden()
    const paperRow = page.getByRole('row').filter({ hasText: paperTitle })
    await expect(paperRow).toBeVisible()
    const paperId = (await paperRow.innerText()).match(/P\d+/)?.[0] ?? ''
    expect(paperId).toMatch(/^P\d+$/)
    await paperRow.getByRole('button', { name: '查看详情' }).click()
    const previewPaper = page.getByRole('button', { name: '明确预览 PDF' })
    await previewPaper.click()
    const pdfDialog = page.getByRole('dialog', { name: new RegExp(`${paperId} .*PDF 预览`) })
    await expect(pdfDialog.getByTitle('Newspaper Issue 权威 PDF 预览')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(previewPaper).toBeFocused()

    await openArchiveTab(page, '收录作品')
    const createWork = page.getByRole('button', { name: '创建 Work' })
    await createWork.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(createWork).toBeFocused()
    await createWork.click()
    const workDialog = page.getByRole('dialog', { name: '创建 Work' })
    await workDialog.getByRole('textbox', { name: /标题/ }).fill(workTitle)
    await workDialog.getByRole('textbox', { name: /作者/ }).fill('Browser Operator')
    await workDialog.locator('input[type="file"]').setInputFiles(workPackage)
    await workDialog.getByRole('button', { name: '创建并上传' }).click()
    await expect(workDialog).toBeHidden()
    const workRow = page.getByRole('row').filter({ hasText: workTitle })
    await expect(workRow).toBeVisible()
    const workId = (await workRow.innerText()).match(/W\d+/)?.[0] ?? ''
    expect(workId).toMatch(/^W\d+$/)

    const search = page.getByRole('textbox', { name: '搜索 Works' })
    await search.fill(workTitle)
    await expect.poll(() => new URL(page.url()).searchParams.get('workSearch')).toBe(workTitle)
    await expect(page.getByRole('row').filter({ hasText: workTitle })).toBeVisible()
    await page.goBack()
    await expect(search).toHaveValue('')
    await expect.poll(() => new URL(page.url()).searchParams.get('work')).toBe(workId)
    await page.reload()
    await expect(page.getByRole('heading', { name: `${workId} · ${workTitle}` })).toBeVisible()

    const previewWork = page.getByRole('button', { name: '浏览安全预览' })
    await previewWork.click()
    const workPreviewDialog = page.getByRole('dialog', { name: new RegExp(`${workId} .*安全派生预览`) })
    const readme = workPreviewDialog.getByRole('button').filter({ hasText: 'README.txt' })
    await expect(readme).toBeVisible()
    await readme.click()
    await expect(workPreviewDialog.locator('pre.text-preview')).toContainText('Archive browser acceptance preview.')
    await page.keyboard.press('Escape')
    await expect(previewWork).toBeFocused()

    const addAppearance = page.getByRole('button', { name: '添加刊载关联' })
    await addAppearance.focus()
    await page.keyboard.press('Enter')
    const appearanceDialog = page.getByRole('dialog', { name: new RegExp(`关联 ${workId}`) })
    await appearanceDialog.locator('.el-select').click()
    await page.locator('.el-select-dropdown:visible').getByRole('option', { name: new RegExp(`^${paperId} .*${paperTitle}$`) }).click()
    await appearanceDialog.getByRole('textbox', { name: '页码（可选）' }).fill('7')
    await appearanceDialog.getByRole('textbox', { name: '栏目（可选）' }).fill('Browser')
    await appearanceDialog.getByRole('spinbutton', { name: /显示顺序/ }).fill('2')
    await appearanceDialog.getByRole('button', { name: '保存关联' }).click()
    await expect(appearanceDialog).toBeHidden()
    await expect(page.locator('.appearance-list li').filter({ hasText: paperTitle })).toContainText('第 7 页')

    await openArchiveTab(page, '运维')
    const removeInput = page.getByRole('textbox', { name: '要移除的 Archive Identifier' })
    await removeInput.fill(workId)
    await removeInput.press('Enter')
    const removeDialog = page.getByRole('dialog', { name: '移除 Archive Item' })
    await expect(removeDialog).toContainText(`目标：${workId}`)
    await expect(removeDialog).toContainText('30 天内仍可恢复')
    await removeDialog.getByRole('button', { name: '确认移除 Archive Item' }).click()
    await expect(removeDialog).toBeHidden()
    await expect(removeInput).toBeFocused()
    const removedRow = page.getByRole('row').filter({ hasText: workTitle })
    await expect(removedRow).toContainText(workId)
    await expect(removedRow).toContainText('removed')
    await removedRow.getByRole('button', { name: '恢复', exact: true }).click()
    const restoreDialog = page.getByRole('dialog', { name: '恢复 Archive Item' })
    await expect(restoreDialog).toContainText('保留 Publication Appearances')
    await restoreDialog.getByRole('button', { name: '确认恢复 Archive Item' }).click()
    await expect(restoreDialog).toBeHidden()

    await openArchiveTab(page, '收录作品')
    const restoredRow = page.getByRole('row').filter({ hasText: workTitle })
    await expect(restoredRow).toContainText(workId)
    await restoredRow.getByRole('button', { name: '查看详情' }).click()
    const appearance = page.locator('.appearance-list li').filter({ hasText: paperTitle })
    await expect(appearance).toContainText('第 7 页')
    await appearance.getByRole('button', { name: '解除关联' }).click()
    const unlinkDialog = page.getByRole('dialog', { name: '解除刊载关联？' })
    await expect(unlinkDialog).toContainText(`${workId} 与 ${paperId}`)
    await unlinkDialog.getByRole('button', { name: '解除关联' }).click()
    await expect(page.getByText('尚无 Publication Appearance')).toBeVisible()

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/memebot/archive?tab=issues')
    await expect(page.locator('.desktop-results')).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: paperTitle })).toBeVisible()
    await expectNoHorizontalScroll(page)

    await page.setViewportSize({ width: 767, height: 900 })
    await expect(page.locator('.desktop-results')).toBeHidden()
    await expect(page.locator('.mobile-results').filter({ hasText: paperTitle })).toBeVisible()
    await expectNoHorizontalScroll(page)

    await openArchiveTab(page, '收录作品')
    await expect(page.locator('.mobile-results').filter({ hasText: workTitle })).toBeVisible()
    await expectNoHorizontalScroll(page)

    await openArchiveTab(page, '运维')
    await expect(page.getByRole('heading', { name: '备份与恢复' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '生命周期审计' })).toBeVisible()
    await expect(page.locator('[aria-label="生命周期历史卡片"]')).toBeVisible()
    await expect(page.locator('[aria-label="生命周期历史卡片"] .lifecycle-card').first()).toBeVisible()
    await expectNoHorizontalScroll(page)
    await page.screenshot({ path: testInfo.outputPath('archive-mobile-767.png'), fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('[aria-label="生命周期历史卡片"] .lifecycle-card').first()).toBeVisible()
    await expectNoHorizontalScroll(page)
    await openArchiveTab(page, '报纸期数')
    await expect(page.locator('.mobile-results').filter({ hasText: paperTitle })).toBeVisible()
    await expectNoHorizontalScroll(page)
    await page.screenshot({ path: testInfo.outputPath('archive-mobile-390.png'), fullPage: true })
  })

  test('opens the activity:archive entry in light and dark themes', async ({ page }, testInfo) => {
    let lightPalette = ''
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto('/')
      const entry = page.locator('a[href="/memebot/archive"]').first()
      await expect(entry).toBeVisible()
      await entry.click()
      await expect(page.getByRole('heading', { name: '迷因档案' })).toBeVisible()
      await expect.poll(() => page.evaluate(scheme => matchMedia(`(prefers-color-scheme: ${scheme})`).matches, colorScheme)).toBe(true)
      const palette = await page.evaluate(() => {
        const style = getComputedStyle(document.body)
        return `${style.color}|${style.backgroundColor}|${style.colorScheme}`
      })
      expect(palette).not.toBe('')
      if (colorScheme === 'light') lightPalette = palette
      else expect(palette).not.toBe(lightPalette)
      await page.screenshot({ path: testInfo.outputPath(`archive-${colorScheme}.png`), fullPage: true })
      testInfo.annotations.push({ type: 'theme', description: `${colorScheme} theme executed through activity:archive.` })
    }
  })

  test('exercises Auth/Login absent mode', async ({ page }, testInfo) => {
    test.skip(authMode !== 'absent', 'NOT EXECUTED: this environment declares Auth/Login installed mode.')
    await page.goto('/memebot/archive')
    await expect(page.getByRole('heading', { name: '迷因档案' })).toBeVisible()
    expect(new URL(page.url()).pathname).not.toMatch(/login|auth/i)
    testInfo.annotations.push({ type: 'auth', description: 'Auth/Login absent mode executed; Archive remained available at authority-1 Console route.' })
  })

  test('exercises Auth/Login installed mode', async ({ page }, testInfo) => {
    test.skip(authMode !== 'installed', 'NOT EXECUTED: Auth/Login is not installed in this local Koishi app.')
    test.skip(!process.env.MEMEBOT_ARCHIVE_AUTH_STORAGE_STATE, 'NOT EXECUTED: installed auth mode requires MEMEBOT_ARCHIVE_AUTH_STORAGE_STATE.')
    await page.goto('/memebot/archive')
    await expect(page.getByRole('heading', { name: '迷因档案' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /用户名|账号|密码|登录/i })).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe('/memebot/archive')
    testInfo.annotations.push({ type: 'auth', description: 'Auth/Login installed mode executed with the supplied authenticated storage state.' })
  })

  test('retries an Archive Backup when an R2 failure fixture is available', async ({ page }) => {
    test.skip(!backupRetryAvailable, 'NOT EXECUTED: no failed R2 Archive Backup fixture is available.')
    await page.goto('/memebot/archive?tab=ops')
    const retry = page.getByRole('button', { name: '立即重试' }).first()
    await expect(retry).toBeVisible()
    await retry.click()
    await expect(retry).not.toHaveAttribute('aria-busy', 'true')
  })

  test('generates the R2 recovery preview when R2 manifests are available', async ({ page }) => {
    test.skip(!r2RecoveryAvailable, 'NOT EXECUTED: no R2 recovery manifests are available.')
    await page.goto('/memebot/archive?tab=ops')
    await page.getByRole('button', { name: '从 R2 生成预览' }).click()
    await expect(page.getByLabel('R2 恢复差异摘要')).toBeVisible()
  })
})
