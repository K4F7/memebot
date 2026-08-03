import { expect, test } from '@playwright/test'

test('completes the four five-plugin Sandbox routes', async ({ page }) => {
  const token = Date.now().toString()
  const activityTitle = `Final acceptance activity ${token}`
  const paperTitle = `Final acceptance ${token}`
  await page.goto('/sandbox')
  await page.getByText('添加用户', { exact: true }).click()
  await page.getByText('用户设置', { exact: true }).click()
  const authority = page.getByRole('spinbutton')
  await authority.fill('4')
  await authority.press('Enter')
  await page.getByText('私聊模式', { exact: true }).click()

  const input = page.getByRole('textbox', { name: '发送消息到沙盒' })
  const main = page.locator('main')
  async function send(message: string) {
    await input.fill(message)
    await input.press('Enter')
    await page.waitForTimeout(350)
  }

  const start = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
  const end = new Date(Date.now() + 26 * 60 * 60_000).toISOString()
  await send('activity.add')
  await expect(main).toContainText('请输入活动标题。')
  for (const value of [activityTitle, start, end, '-', '-', '-', '仅保存']) await send(value)
  await expect(main).toContainText('活动创建成功')
  await send('activity')
  await expect(main).toContainText(activityTitle)

  await send('faq.add')
  await expect(main).toContainText('请输入问题。')
  await send('最终验收问题')
  await expect(main).toContainText('请输入答案。')
  await send('最终验收答案')
  await expect(main).toContainText('请发送“确认”')
  await send('确认')
  await expect(main).toContainText('FAQ 新增成功')

  const pdf = Buffer.from('%PDF-1.7\nfinal acceptance\n%%EOF').toString('base64')
  const paper = JSON.stringify({
    month: '2026-08', issueNumber: token.slice(-6), title: paperTitle,
    attachment: { filename: 'final.pdf', contentType: 'application/pdf', data: `data:application/pdf;base64,${pdf}` },
  })
  await send(`archive.issue-publish ${paper}`)
  await expect(main).toContainText('已发布 Newspaper Issue')
  await send(`archive.search paper ${token}`)
  await expect(main).toContainText(paperTitle)

  await send('feedback')
  await expect(main).toContainText('已开始收集')
  await send('最终验收反馈')
  await expect(main).toContainText('已收集')
  await send('提交')
  await expect(main).toContainText(/已提交 反馈#\d+/)
})
