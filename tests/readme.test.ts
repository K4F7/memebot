import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8')

describe('root README plugin catalog', () => {
  it('documents exactly the five plugin packages', () => {
    const documentedPackages = [...readme.matchAll(/`(koishi-plugin-memebot-[a-z-]+)`/g)]
      .map(([, packageName]) => packageName)

    expect([...new Set(documentedPackages)].sort()).toEqual([
      'koishi-plugin-memebot-access',
      'koishi-plugin-memebot-activity',
      'koishi-plugin-memebot-archive',
      'koishi-plugin-memebot-faq',
      'koishi-plugin-memebot-intake',
    ])
  })

  it('keeps plugin documentation in the repository README', () => {
    const pluginRoot = resolve(process.cwd(), 'plugins')
    const pluginReadmes = readdirSync(pluginRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('memebot-'))
      .flatMap((entry) => readdirSync(resolve(pluginRoot, entry.name))
        .filter((name) => /^readme(?:\.[^.]+)?$/i.test(name))
        .map((name) => `${entry.name}/${name}`))

    expect(pluginReadmes).toEqual([])
  })
})
