const { spawnSync } = require('node:child_process')
const { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } = require('node:fs')
const Module = require('node:module')
const { tmpdir } = require('node:os')
const { delimiter, join, relative, resolve, sep } = require('node:path')

const ACCESS_PACKAGE = 'koishi-plugin-memebot-access'
const CANONICAL_REPOSITORY_URLS = new Set([
  'https://github.com/K4F7/memebot.git',
  'https://github.com/K4F7/memebot',
  'git+https://github.com/K4F7/memebot.git',
  'git+https://github.com/K4F7/memebot',
])
const WORKSPACE_PROTOCOL = /^(workspace|file|link|portal|exec|patch):/
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']

class ArtifactContractError extends Error {
  constructor(pluginName, violation) {
    super(`${pluginName} violates the independent package artifact contract: ${violation}`)
    this.name = 'ArtifactContractError'
    this.pluginName = pluginName
    this.violation = violation
  }
}

function artifactError(pluginName, violation) {
  return new ArtifactContractError(pluginName, violation)
}

function discoverPublishablePlugins(repositoryRoot) {
  const pluginsRoot = resolve(repositoryRoot, 'plugins')
  return readdirSync(pluginsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('memebot-'))
    .map(entry => {
      const directory = `plugins/${entry.name}`
      const root = resolve(repositoryRoot, directory)
      return { directory, root, manifest: readSourceManifest(root, directory) }
    })
    .sort((left, right) => left.directory.localeCompare(right.directory))
}

function readSourceManifest(pluginRoot, pluginDirectory) {
  const manifestPath = join(pluginRoot, 'package.json')
  if (!existsSync(manifestPath)) {
    throw artifactError(pluginDirectory, 'source package is missing its manifest')
  }

  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw artifactError(pluginDirectory, 'source package manifest is malformed')
  }
}

function isCanonicalRepositoryUrl(url) {
  return typeof url === 'string' && CANONICAL_REPOSITORY_URLS.has(url.trim())
}

function assertCanonicalRepository(manifest, pluginDirectory, pluginName = manifest.name || pluginDirectory) {
  const repository = manifest.repository
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    throw artifactError(pluginName, 'must declare canonical repository metadata for K4F7/memebot including its package directory')
  }

  if (repository.type !== 'git' || !isCanonicalRepositoryUrl(repository.url) || repository.directory !== pluginDirectory) {
    throw artifactError(pluginName, 'must declare canonical repository metadata for K4F7/memebot including its package directory')
  }
}

function listedDependencies(manifest) {
  return DEPENDENCY_FIELDS.flatMap((field) => {
    const group = manifest[field]
    if (!group || typeof group !== 'object' || Array.isArray(group)) return []
    return Object.entries(group).map(([name, range]) => ({ field, name, range }))
  })
}

function assertNoWorkspaceRanges(manifest, pluginName) {
  const leftover = listedDependencies(manifest).find(({ range }) => typeof range === 'string' && WORKSPACE_PROTOCOL.test(range))
  if (leftover) {
    throw artifactError(pluginName, `packed manifest retains a workspace: dependency range on ${leftover.name}`)
  }
}

function isConcreteCompatibleRange(range, version) {
  return range === version || range === `^${version}` || range === `~${version}`
}

function assertAccessDependency(manifest, pluginName, { requiresAccess, accessVersion } = {}) {
  if (!requiresAccess) return

  const range = manifest.dependencies?.[ACCESS_PACKAGE]
  if (typeof range !== 'string' || WORKSPACE_PROTOCOL.test(range) || !isConcreteCompatibleRange(range, accessVersion)) {
    throw artifactError(pluginName, `must pack a concrete compatible dependency on the published ${ACCESS_PACKAGE} package`)
  }
}

function shippedPaths(manifest) {
  const paths = ['package.json']
  if (typeof manifest.main === 'string' && manifest.main) paths.push(manifest.main)
  if (typeof manifest.types === 'string' && manifest.types) paths.push(manifest.types)
  if (Array.isArray(manifest.files)) {
    for (const entry of manifest.files) {
      if (typeof entry === 'string' && entry) paths.push(entry)
    }
  }
  return [...new Set(paths)]
}

function assertInsideExtractedRoot(extractedRoot, candidate) {
  const relativePath = relative(extractedRoot, candidate)
  return relativePath !== '' && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith('..')
}

function assertShippedArtifacts(extractedRoot, manifest, pluginName) {
  if (typeof manifest.main !== 'string' || !manifest.main) {
    throw artifactError(pluginName, 'packed manifest is missing its declared JavaScript entry')
  }
  if (typeof manifest.types !== 'string' || !manifest.types) {
    throw artifactError(pluginName, 'packed manifest is missing its declared type declaration entry')
  }

  for (const shippedPath of shippedPaths(manifest)) {
    const candidate = resolve(extractedRoot, shippedPath)
    if (!assertInsideExtractedRoot(extractedRoot, candidate) || !existsSync(candidate)) {
      if (shippedPath === manifest.main) {
        throw artifactError(pluginName, 'packed artifact is missing its declared JavaScript entry')
      }
      if (shippedPath === manifest.types) {
        throw artifactError(pluginName, 'packed artifact is missing its declared type declaration entry')
      }
      if (shippedPath === 'package.json') {
        throw artifactError(pluginName, 'packed artifact is missing its manifest')
      }
      throw artifactError(pluginName, `packed artifact is missing required shipped path ${shippedPath}`)
    }

    if ((shippedPath === 'lib' || shippedPath === 'dist' || shippedPath.endsWith('/')) && !statSync(candidate).isDirectory()) {
      throw artifactError(pluginName, `packed artifact is missing required shipped path ${shippedPath}`)
    }
  }
}

function withNodePath(moduleResolveRoots, fn) {
  const previous = process.env.NODE_PATH
  process.env.NODE_PATH = moduleResolveRoots.join(delimiter)
  Module._initPaths()
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.NODE_PATH
    else process.env.NODE_PATH = previous
    Module._initPaths()
  }
}

function loadExtractedPlugin(entryPath, pluginName, moduleResolveRoots = []) {
  let exports
  try {
    exports = withNodePath(moduleResolveRoots, () => {
      delete require.cache[entryPath]
      return require(entryPath)
    })
  } catch {
    throw artifactError(pluginName, 'packed CommonJS entry cannot be loaded')
  }

  const plugin = exports && (exports.default || exports)
  if (!plugin || typeof plugin !== 'object') {
    throw artifactError(pluginName, 'packed CommonJS entry must export a Koishi plugin object')
  }
  if (typeof plugin.apply !== 'function') {
    throw artifactError(pluginName, 'packed CommonJS entry must export an apply function')
  }
  return plugin
}

function readPackedManifest(extractedRoot, pluginName) {
  const manifestPath = join(extractedRoot, 'package.json')
  if (!existsSync(manifestPath)) {
    throw artifactError(pluginName, 'packed artifact is missing its manifest')
  }

  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw artifactError(pluginName, 'packed manifest is malformed')
  }
}

function verifyExtractedArtifact(extractedRoot, options = {}) {
  const pluginName = options.pluginName || 'unknown package'
  const manifest = readPackedManifest(extractedRoot, pluginName)
  const resolvedName = manifest.name || pluginName

  assertCanonicalRepository(manifest, options.pluginDirectory, resolvedName)
  assertNoWorkspaceRanges(manifest, resolvedName)
  assertAccessDependency(manifest, resolvedName, options)
  assertShippedArtifacts(extractedRoot, manifest, resolvedName)
  loadExtractedPlugin(resolve(extractedRoot, manifest.main), resolvedName, options.moduleResolveRoots)
  return manifest
}

function packPluginTarball(repositoryRoot, workspaceName, tarballPath) {
  const result = spawnSync('yarn', ['workspace', workspaceName, 'pack', '--out', tarballPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw artifactError(workspaceName, 'could not be packed into an independent package artifact')
  }
}

function extractTarball(tarballPath, extractDir) {
  mkdirSync(extractDir, { recursive: true })
  const result = spawnSync('tar', ['-xzf', tarballPath, '-C', extractDir], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw artifactError('package artifact', 'could not be extracted for independent package validation')
  }
}

function withArtifactStaging(fn) {
  const stagingRoot = mkdtempSync(join(tmpdir(), 'memebot-plugin-artifacts-'))
  try {
    return fn(stagingRoot)
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true })
  }
}

function verifyPublishablePlugins(repositoryRoot) {
  const plugins = discoverPublishablePlugins(repositoryRoot)
  const access = plugins.find(plugin => plugin.manifest.name === ACCESS_PACKAGE)
  if (!access) {
    throw artifactError(ACCESS_PACKAGE, 'must be present as the published Access package')
  }

  return withArtifactStaging((stagingRoot) => {
    for (const plugin of plugins) {
      const pluginName = plugin.manifest.name
      assertCanonicalRepository(plugin.manifest, plugin.directory, pluginName)

      const artifactId = plugin.directory.replaceAll('/', '-')
      const tarballPath = join(stagingRoot, `${artifactId}.tgz`)
      const extractDir = join(stagingRoot, artifactId)
      packPluginTarball(repositoryRoot, pluginName, tarballPath)
      extractTarball(tarballPath, extractDir)

      const extractedRoot = join(extractDir, 'package')
      if (!existsSync(extractedRoot)) {
        throw artifactError(pluginName, 'packed artifact is missing its extracted package contents')
      }

      verifyExtractedArtifact(extractedRoot, {
        pluginName,
        pluginDirectory: plugin.directory,
        requiresAccess: Boolean(plugin.manifest.dependencies?.[ACCESS_PACKAGE]),
        accessVersion: access.manifest.version,
        moduleResolveRoots: [resolve(repositoryRoot, 'node_modules')],
      })
    }

    return plugins.length
  })
}

module.exports = {
  ACCESS_PACKAGE,
  ArtifactContractError,
  assertCanonicalRepository,
  discoverPublishablePlugins,
  loadExtractedPlugin,
  verifyExtractedArtifact,
  verifyPublishablePlugins,
  withArtifactStaging,
}

if (require.main === module) {
  try {
    const count = verifyPublishablePlugins(resolve(__dirname, '..'))
    console.log(`Verified ${count} independent plugin package artifacts.`)
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : cause)
    process.exitCode = 1
  }
}
