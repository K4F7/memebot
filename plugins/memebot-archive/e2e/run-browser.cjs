const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { resolve } = require('node:path')

const required = process.argv.includes('--required')
const passthrough = process.argv.slice(2).filter(argument => argument !== '--required')
const url = process.env.MEMEBOT_ARCHIVE_WEBUI_URL

function unavailable(reason) {
  const status = required ? 'REQUIRED BUT NOT EXECUTED' : 'NOT EXECUTED'
  process.stdout.write(`Archive browser acceptance: ${status} (${reason}).\n`)
  process.exitCode = required ? 1 : 0
}

if (!url) {
  unavailable('MEMEBOT_ARCHIVE_WEBUI_URL is not set')
  return
}

let executablePath
try {
  executablePath = require('@playwright/test').chromium.executablePath()
} catch (cause) {
  unavailable(`Playwright Chromium could not be resolved: ${cause.message}`)
  return
}

if (!existsSync(executablePath)) {
  unavailable(`Chromium is unavailable at ${executablePath}`)
  return
}

const packageRoot = resolve(__dirname, '..')
const playwrightCli = require.resolve('@playwright/test/cli')
process.stdout.write(`Archive browser acceptance: EXECUTING against ${url}.\n`)
if ((process.env.MEMEBOT_ARCHIVE_AUTH_MODE ?? 'absent') !== 'installed') {
  process.stdout.write('Auth/Login installed mode: NOT EXECUTED (Auth/Login is absent in this environment).\n')
} else if (!process.env.MEMEBOT_ARCHIVE_AUTH_STORAGE_STATE) {
  process.stdout.write('Auth/Login installed mode: NOT EXECUTED (authenticated storage state is unavailable).\n')
}
if (process.env.MEMEBOT_ARCHIVE_BACKUP_RETRY !== 'available') {
  process.stdout.write('R2 Archive Backup retry: NOT EXECUTED (no failed backup fixture is available).\n')
}
if (process.env.MEMEBOT_ARCHIVE_R2_RECOVERY !== 'available') {
  process.stdout.write('R2 recovery preview: NOT EXECUTED (no R2 manifests are available).\n')
}
const result = spawnSync(process.execPath, [playwrightCli, 'test', '-c', 'playwright.config.ts', ...passthrough], {
  cwd: packageRoot,
  env: process.env,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`Archive browser acceptance could not start: ${result.error.message}`)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
