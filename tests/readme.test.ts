import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8')

describe('root README plugin catalog', () => {
  it('documents exactly the four publishable plugins', () => {
    const documentedPackages = [...readme.matchAll(/`(koishi-plugin-memebot-[a-z-]+)`/g)]
      .map(([, packageName]) => packageName)

    expect([...new Set(documentedPackages)].sort()).toEqual([
      'koishi-plugin-memebot-activity',
      'koishi-plugin-memebot-archive',
      'koishi-plugin-memebot-faq',
      'koishi-plugin-memebot-intake',
    ])
  })
})
