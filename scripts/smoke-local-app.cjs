const { spawn, spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const { resolve } = require('node:path')

const localPlugins = {
  'koishi-plugin-memebot-access': 'file:../plugins/memebot-access',
  'koishi-plugin-memebot-intake': 'file:../plugins/memebot-intake',
  'koishi-plugin-memebot-faq': 'file:../plugins/memebot-faq',
  'koishi-plugin-memebot-activity': 'file:../plugins/memebot-activity',
  'koishi-plugin-memebot-archive': 'file:../plugins/memebot-archive',
}

const requiredConfigEntries = [
  'server',
  'console',
  'sandbox',
  'database-sqlite',
  'memebot-access',
  'memebot-intake',
  'memebot-faq',
  'memebot-activity',
  'memebot-archive',
]

function enabledConfigEntry(config, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s{2,}${escapedName}(?::[^:\\s]+)?:\\s*([^#\\r\\n]*)`, 'm').exec(config)
  const value = match?.[1].trim().toLowerCase()
  return !!match && !['false', 'null', '~'].includes(value)
}

function validateLocalApp(appRoot) {
  const errors = []
  const manifestPath = resolve(appRoot, 'package.json')
  const configPath = resolve(appRoot, 'koishi.yml')
  let manifest = {}

  if (!existsSync(manifestPath)) {
    errors.push('package.json is missing')
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (cause) {
      errors.push(`package.json is invalid: ${cause.message}`)
    }
  }

  if (!manifest.scripts?.start) errors.push('package.json must define a start script')
  for (const [name, specifier] of Object.entries(localPlugins)) {
    if (manifest.dependencies?.[name] !== specifier) errors.push(`${name} must use ${specifier}`)
  }
  if (manifest.resolutions?.['koishi-plugin-memebot-access'] !== localPlugins['koishi-plugin-memebot-access']) {
    errors.push('koishi-plugin-memebot-access resolution must use file:../plugins/memebot-access')
  }

  if (!existsSync(configPath)) {
    errors.push('koishi.yml is missing')
  } else {
    const config = readFileSync(configPath, 'utf8')
    for (const name of requiredConfigEntries) {
      if (!enabledConfigEntry(config, name)) errors.push(`koishi.yml must enable ${name}`)
    }
  }

  return errors
}

function isKoishiConsoleResponse(statusCode, body) {
  return statusCode === 200 && body.includes('KOISHI_CONFIG =')
}

function localAppUrl(appRoot) {
  const configPath = resolve(appRoot, 'koishi.yml')
  if (!existsSync(configPath)) return 'http://127.0.0.1:5140/'
  const config = readFileSync(configPath, 'utf8')
  const host = /^\s+host:\s*([^\s#]+)/m.exec(config)?.[1] ?? '127.0.0.1'
  const port = /^\s+port:\s*(\d+)/m.exec(config)?.[1] ?? '5140'
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`
}

function portIsListening(url) {
  return new Promise((resolvePort) => {
    const target = new URL(url)
    const socket = net.connect(Number(target.port || 80), target.hostname)
    const finish = (listening) => {
      socket.destroy()
      resolvePort(listening)
    }
    socket.setTimeout(1_000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function probe(url) {
  return new Promise((resolveProbe) => {
    const request = http.get(url, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size <= 1_000_000) chunks.push(chunk)
      })
      response.on('end', () => resolveProbe(isKoishiConsoleResponse(response.statusCode, Buffer.concat(chunks).toString('utf8'))))
    })
    request.setTimeout(1_000, () => request.destroy())
    request.on('error', () => resolveProbe(false))
  })
}

function visibleStartupFailures(logs) {
  return logs.split(/\r?\n/).filter(line => /\[E\]|\bfailed\b|\bError:|\b(?:duplicate|duplicated|conflict(?:ing)?|already (?:exists|registered)|overwrit(?:e|ing|ten))\b/i.test(line))
}

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds))

async function stopProcess(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      if (child.exitCode === null) child.kill('SIGTERM')
    }
    await wait(1_000)
    try {
      process.kill(-child.pid, 0)
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
}

async function runStartupSmoke(appRoot, options = {}) {
  const errors = validateLocalApp(appRoot)
  if (errors.length) throw new Error(`Local Koishi app preflight failed:\n- ${errors.join('\n- ')}`)

  const timeoutMs = options.timeoutMs ?? Number(process.env.MEMEBOT_APP_SMOKE_TIMEOUT_MS ?? 60_000)
  const settleMs = options.settleMs ?? Number(process.env.MEMEBOT_APP_SMOKE_SETTLE_MS ?? 5_000)
  const url = options.url ?? process.env.MEMEBOT_APP_URL ?? localAppUrl(appRoot)
  if (await portIsListening(url)) throw new Error(`Local Koishi app port is already in use: ${url}`)
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'yarn'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'yarn start'] : ['start']
  const child = spawn(command, args, {
    cwd: appRoot,
    detached: process.platform !== 'win32',
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  let spawnError
  child.stdout.on('data', chunk => output.push(String(chunk)))
  child.stderr.on('data', chunk => output.push(String(chunk)))
  child.on('error', cause => { spawnError = cause })

  const startedAt = Date.now()
  let readyAt
  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (spawnError) throw new Error(`Koishi could not be started: ${spawnError.message}.\n${output.join('')}`)
      const visibleErrors = visibleStartupFailures(output.join(''))
      if (visibleErrors.length) throw new Error(`Koishi reported startup failures:\n${visibleErrors.join('\n')}`)
      if (child.exitCode !== null) {
        throw new Error(`Koishi exited during startup with code ${child.exitCode}.\n${output.join('')}`)
      }
      if (readyAt) {
        if (!await probe(url)) throw new Error(`Koishi Console became unavailable during startup: ${url}.\n${output.join('')}`)
        if (Date.now() - readyAt >= settleMs) {
          const logs = output.join('')
          const missingPlugins = Object.keys(localPlugins)
            .map(name => name.replace('koishi-plugin-', ''))
            .filter(name => !logs.includes(`apply plugin ${name}:`))
          if (missingPlugins.length) throw new Error(`Koishi did not load required plugins: ${missingPlugins.join(', ')}.\n${logs}`)
          return logs
        }
      } else if (await probe(url)) {
        readyAt = Date.now()
      }
      await wait(250)
    }
    throw new Error(`Koishi did not become ready at ${url} within ${timeoutMs}ms.\n${output.join('')}`)
  } finally {
    await stopProcess(child)
  }
}

module.exports = { isKoishiConsoleResponse, localAppUrl, localPlugins, runStartupSmoke, validateLocalApp, visibleStartupFailures }

if (require.main === module) {
  const appRoot = resolve(__dirname, '..', 'app')
  runStartupSmoke(appRoot)
    .then((logs) => {
      process.stdout.write(logs)
      process.stdout.write('Local Koishi app smoke check passed.\n')
    })
    .catch((cause) => {
      console.error(cause instanceof Error ? cause.message : cause)
      process.exitCode = 1
    })
}
