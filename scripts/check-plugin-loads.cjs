const assert = require('node:assert/strict')
const { readdirSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const repositoryRoot = resolve(__dirname, '..')
const defaultPluginRoots = readdirSync(resolve(repositoryRoot, 'plugins'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith('memebot-'))
  .map(entry => resolve(repositoryRoot, 'plugins', entry.name))

const pluginRoots = process.argv.length > 2
  ? process.argv.slice(2).map(pluginRoot => resolve(pluginRoot))
  : defaultPluginRoots

for (const pluginRoot of pluginRoots) {
  const manifestPath = resolve(pluginRoot, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entryPath = resolve(pluginRoot, manifest.main)

  let exports
  try {
    exports = require(entryPath)
  } catch (cause) {
    throw new Error(`${manifest.name} cannot be loaded through its CommonJS entry`, { cause })
  }

  const plugin = exports.default || exports
  assert.equal(typeof plugin, 'object', `${manifest.name} must export a Koishi plugin object`)
  assert.equal(typeof plugin.apply, 'function', `${manifest.name} must export an apply function`)
}

console.log(`Loaded ${pluginRoots.length} Koishi plugin entries successfully.`)
