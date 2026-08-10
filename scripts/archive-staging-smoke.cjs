'use strict'

const { createHmac } = require('node:crypto')
const { dirname } = require('node:path')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_FIXTURE_MIME = 'image/png'
const DEFAULT_FIXTURE_FILENAME = 'archive-staging-smoke.png'

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

function normalizeWorkId(value) {
  const id = String(value || '').trim().toUpperCase()
  return /^W[1-9]\d*$/.test(id) ? id : undefined
}

function normalizeUrls(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('MEMEBOT_ARCHIVE_STAGING_URL is required.')
  const input = new URL(raw.endsWith('/') ? raw : `${raw}/`)
  if (!['http:', 'https:'].includes(input.protocol)) throw new Error('staging URL must use HTTP(S).')

  const marker = '/api/archive/v1'
  const markerIndex = input.pathname.indexOf(marker)
  const site = new URL(input)
  const api = new URL(input)
  if (markerIndex >= 0) {
    site.pathname = input.pathname.slice(0, markerIndex) || '/'
    site.search = ''
    site.hash = ''
    api.pathname = `${input.pathname.slice(0, markerIndex + marker.length).replace(/\/+$/, '')}/`
  } else {
    site.pathname = input.pathname.replace(/\/+$/, '') || '/'
    site.search = ''
    site.hash = ''
    api.pathname = `${site.pathname.replace(/\/+$/, '')}/api/archive/v1/`.replace(/^\/api/, '/api')
  }
  api.search = ''
  api.hash = ''
  return {
    siteUrl: site.toString(),
    apiUrl: api.toString(),
  }
}

function buildStagingConfig(env = process.env, argv = process.argv) {
  const required = truthy(env.MEMEBOT_ARCHIVE_STAGING_REQUIRED) || argv.includes('--required')
  const rawUrl = String(env.MEMEBOT_ARCHIVE_STAGING_URL || '').trim()
  const token = String(env.MEMEBOT_ARCHIVE_STAGING_TOKEN || '').trim()
  if (!rawUrl || !token) return { enabled: false, required, reason: 'missing-url-or-token' }

  let urls
  try {
    urls = normalizeUrls(rawUrl)
  } catch {
    return { enabled: false, required, reason: 'invalid-url' }
  }

  const timeoutValue = Number(env.MEMEBOT_ARCHIVE_STAGING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  return {
    enabled: true,
    required,
    token,
    ...urls,
    workId: normalizeWorkId(env.MEMEBOT_ARCHIVE_STAGING_WORK_ID),
    afterUrl: String(env.MEMEBOT_ARCHIVE_STAGING_AFTER_URL || '').trim() || undefined,
    stateFile: String(env.MEMEBOT_ARCHIVE_STAGING_STATE_FILE || '').trim() || undefined,
    outageUrl: String(env.MEMEBOT_ARCHIVE_STAGING_OUTAGE_URL || '').trim() || undefined,
    failedMediaUrl: String(env.MEMEBOT_ARCHIVE_STAGING_FAILED_MEDIA_URL || '').trim() || undefined,
    failedMediaWorkId: normalizeWorkId(env.MEMEBOT_ARCHIVE_STAGING_FAILED_MEDIA_WORK_ID),
    directMediaUrl: String(env.MEMEBOT_ARCHIVE_STAGING_DIRECT_MEDIA_URL || '').trim() || undefined,
    mediaSigningSecret: String(env.MEMEBOT_ARCHIVE_STAGING_MEDIA_SIGNING_SECRET || '').trim() || undefined,
    runKoishi: truthy(env.MEMEBOT_ARCHIVE_STAGING_KOISHI),
    requireKoishi: truthy(env.MEMEBOT_ARCHIVE_STAGING_REQUIRE_KOISHI),
    requireAdmin: truthy(env.MEMEBOT_ARCHIVE_STAGING_REQUIRE_ADMIN),
    requireFailureFixtures: truthy(env.MEMEBOT_ARCHIVE_STAGING_REQUIRE_FAILURE_FIXTURES),
    requirePrivacy: truthy(env.MEMEBOT_ARCHIVE_STAGING_REQUIRE_PRIVACY),
    requireMediaExpiry: truthy(env.MEMEBOT_ARCHIVE_STAGING_REQUIRE_MEDIA_EXPIRY),
    createFixture: truthy(env.MEMEBOT_ARCHIVE_STAGING_CREATE_FIXTURE),
    adminEmail: String(env.MEMEBOT_ARCHIVE_STAGING_ADMIN_EMAIL || '').trim() || undefined,
    adminPassword: String(env.MEMEBOT_ARCHIVE_STAGING_ADMIN_PASSWORD || ''),
    fixtureTitle: String(env.MEMEBOT_ARCHIVE_STAGING_FIXTURE_TITLE || '').trim() || undefined,
    fixtureAuthor: String(env.MEMEBOT_ARCHIVE_STAGING_FIXTURE_AUTHOR || '').trim() || 'Archive staging',
    fixtureFilename: String(env.MEMEBOT_ARCHIVE_STAGING_FIXTURE_FILENAME || '').trim() || DEFAULT_FIXTURE_FILENAME,
    fixtureMime: String(env.MEMEBOT_ARCHIVE_STAGING_FIXTURE_MIME || '').trim() || DEFAULT_FIXTURE_MIME,
    fixtureBase64: String(env.MEMEBOT_ARCHIVE_STAGING_FIXTURE_BASE64 || '').trim() || undefined,
    fixtureMediaCount: Number.isSafeInteger(Number(env.MEMEBOT_ARCHIVE_STAGING_FIXTURE_MEDIA_COUNT)) ? Math.max(1, Math.floor(Number(env.MEMEBOT_ARCHIVE_STAGING_FIXTURE_MEDIA_COUNT))) : 2,
    timeoutMs: Number.isFinite(timeoutValue) ? Math.max(100, Math.floor(timeoutValue)) : DEFAULT_TIMEOUT_MS,
  }
}

function apiUrl(config, path) {
  return new URL(path, config.apiUrl).toString()
}

function siteUrl(config, path) {
  return new URL(path.replace(/^\//, ''), config.siteUrl).toString()
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function request(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs}ms.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function responseBody(response) {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { _text: text }
  }
}

async function requestJson(fetchImpl, url, init, timeoutMs) {
  const response = await request(fetchImpl, url, init, timeoutMs)
  return { response, body: await responseBody(response) }
}

function jsonHeaders(token) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  }
}

function bodyData(body) {
  return body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body
}

function payloadDoc(body) {
  const value = body && typeof body === 'object' && body.doc ? body.doc : bodyData(body)
  if (!value || typeof value !== 'object') throw new Error('Payload response did not contain a document.')
  return value
}

function archiveWork(body) {
  const value = bodyData(body)
  if (!value || typeof value !== 'object') throw new Error('Work response did not contain an object.')
  const id = normalizeWorkId(value.id)
  const media = value.media
  if (!id || !String(value.title || '').trim() || !String(value.author || '').trim() || !Array.isArray(media) || !media.length) {
    throw new Error('Work response is missing a stable id, metadata, or media.')
  }
  return { ...value, id, media }
}

function protectedMediaUrl(config, media) {
  if (!media || typeof media !== 'object') throw new Error('Media descriptor is not an object.')
  const url = new URL(String(media.access?.url || ''), config.apiUrl)
  const api = new URL(config.apiUrl)
  const prefix = `${api.pathname.replace(/\/+$/, '')}/media/`
  let mediaId
  try {
    mediaId = decodeURIComponent(url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '')
  } catch {
    mediaId = ''
  }
  const expires = Number(url.searchParams.get('expires'))
  const signature = String(url.searchParams.get('signature') || '').trim()
  if (url.origin !== new URL(config.siteUrl).origin || mediaId !== String(media.id) || !Number.isSafeInteger(expires) || expires <= 0 || !signature) {
    throw new Error(`Media ${media.id || 'unknown'} does not have a same-origin signed URL.`)
  }
  if (url.hostname.endsWith('.r2.cloudflarestorage.com')) throw new Error('R2 object URL must not be exposed directly.')
  return url
}

function expiredMediaUrl(config, media, now = () => Date.now()) {
  if (!config.mediaSigningSecret) throw new Error('Set MEMEBOT_ARCHIVE_STAGING_MEDIA_SIGNING_SECRET to test expiry with a valid signature.')
  const url = protectedMediaUrl(config, media)
  const expires = Math.floor(now() / 1000) - 1
  const signature = createHmac('sha256', config.mediaSigningSecret)
    .update(`${media.id}.${expires}`)
    .digest('base64url')
  url.searchParams.set('expires', String(expires))
  url.searchParams.set('signature', signature)
  return url
}

function mediaIdFromUrl(value) {
  try {
    const path = new URL(value).pathname.split('/').filter(Boolean)
    return decodeURIComponent(path[path.length - 1] || '')
  } catch {
    return ''
  }
}

function addCheck(checks, name, status, message) {
  checks.push({ name, status, message })
  return status === 'passed'
}

async function check(checks, name, operation) {
  try {
    const message = await operation()
    return addCheck(checks, name, 'passed', message || 'ok')
  } catch (error) {
    addCheck(checks, name, 'failed', errorMessage(error))
    return false
  }
}

function skip(checks, name, message) {
  addCheck(checks, name, 'not-executed', message)
}

function missingCoreMessage(config) {
  if (!config.workId) return 'Set MEMEBOT_ARCHIVE_STAGING_WORK_ID or enable MEMEBOT_ARCHIVE_STAGING_CREATE_FIXTURE.'
  return ''
}

function fixtureBytes(config) {
  if (config.fixtureBase64) {
    const bytes = Buffer.from(config.fixtureBase64, 'base64')
    if (!bytes.length) throw new Error('MEMEBOT_ARCHIVE_STAGING_FIXTURE_BASE64 is empty.')
    return bytes
  }
  // A tiny valid PNG keeps the optional Admin fixture deterministic and secret-free.
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
}

function readPersistenceState(config) {
  if (!config.stateFile || !existsSync(config.stateFile)) return undefined
  try {
    const state = JSON.parse(readFileSync(config.stateFile, 'utf8'))
    if (!normalizeWorkId(state.workId) || !Array.isArray(state.mediaIds)) throw new Error('state file is missing workId/mediaIds.')
    return { workId: normalizeWorkId(state.workId), mediaIds: state.mediaIds.map(String) }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

function writePersistenceState(config, detail) {
  if (!config.stateFile) return
  mkdirSync(dirname(config.stateFile), { recursive: true })
  writeFileSync(config.stateFile, `${JSON.stringify({
    workId: detail.id,
    mediaIds: detail.media.map((media) => String(media.id)),
    recordedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 })
}

async function createAdminFixture(config, fetchImpl, now) {
  if (!config.adminEmail || !config.adminPassword) throw new Error('Admin fixture requires MEMEBOT_ARCHIVE_STAGING_ADMIN_EMAIL and _PASSWORD.')
  const login = await requestJson(fetchImpl, siteUrl(config, '/api/users/login'), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }),
  }, config.timeoutMs)
  if (!login.response.ok) throw new Error(`Admin login returned HTTP ${login.response.status}.`)
  const adminToken = String(login.body?.token || '').trim()
  if (!adminToken) throw new Error('Admin login did not return a token.')
  const title = config.fixtureTitle || `Archive staging smoke ${new Date(now()).toISOString()}`
  const workResponse = await requestJson(fetchImpl, siteUrl(config, '/api/works'), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `JWT ${adminToken}` },
    body: JSON.stringify({ title, author: config.fixtureAuthor, description: 'Created by the opt-in staging smoke.' }),
  }, config.timeoutMs)
  if (!workResponse.response.ok) throw new Error(`Admin Work creation returned HTTP ${workResponse.response.status}.`)
  const work = payloadDoc(workResponse.body)
  const payloadWorkId = String(work.id || '').trim()
  const archiveId = normalizeWorkId(work.archiveId)
  if (!payloadWorkId || !archiveId) throw new Error('Admin Work creation did not return a Payload id and W<n> archive id.')

  const mediaIds = []
  for (let index = 0; index < config.fixtureMediaCount; index += 1) {
    const extension = config.fixtureFilename.includes('.') ? config.fixtureFilename.slice(config.fixtureFilename.lastIndexOf('.')) : ''
    const filename = index === 0 ? config.fixtureFilename : `${config.fixtureFilename.slice(0, config.fixtureFilename.length - extension.length)}-${index + 1}${extension}`
    const form = new FormData()
    form.append('work', payloadWorkId)
    form.append('file', new Blob([fixtureBytes(config)], { type: config.fixtureMime }), filename)
    const mediaResponse = await requestJson(fetchImpl, siteUrl(config, '/api/media'), {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `JWT ${adminToken}` },
      body: form,
    }, config.timeoutMs)
    if (!mediaResponse.response.ok) throw new Error(`Admin Media upload returned HTTP ${mediaResponse.response.status}.`)
    const media = payloadDoc(mediaResponse.body)
    const mediaId = String(media.id || '').trim()
    if (!mediaId) throw new Error('Admin Media upload did not return an id.')
    const relationResponse = await requestJson(fetchImpl, siteUrl(config, '/api/work-media'), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `JWT ${adminToken}` },
      body: JSON.stringify({ work: payloadWorkId, media: mediaId, displayOrder: index, caption: `Staging smoke ${index + 1}` }),
    }, config.timeoutMs)
    if (!relationResponse.response.ok) throw new Error(`Admin WorkMedia creation returned HTTP ${relationResponse.response.status}.`)
    mediaIds.push(mediaId)
  }
  return { workId: archiveId, mediaIds }
}

async function runKoishiClientCheck(config, state, fetchImpl, now) {
  let PayloadArchiveReadAdapter, sendPayloadWork
  try {
    ({ PayloadArchiveReadAdapter, sendPayloadWork } = require('../plugins/memebot-archive/lib/payload-read.js'))
  } catch {
    throw new Error('Build koishi-plugin-memebot-archive before enabling MEMEBOT_ARCHIVE_STAGING_KOISHI=1.')
  }
  const adapter = new PayloadArchiveReadAdapter({
    baseUrl: config.siteUrl,
    serviceToken: config.token,
    timeoutMs: config.timeoutMs,
  }, { fetch: fetchImpl, now })
  const invalidAdapter = new PayloadArchiveReadAdapter({
    baseUrl: config.siteUrl,
    serviceToken: 'wrong-token',
    timeoutMs: config.timeoutMs,
  }, { fetch: fetchImpl, now })
  try {
    await invalidAdapter.searchWorks({ text: state.workId })
    throw new Error('Koishi adapter accepted an invalid machine credential.')
  } catch (error) {
    if (error?.kind !== 'unauthorized') throw error
  }
  const summaries = await adapter.searchWorks({ text: state.workId })
  if (!summaries.some((item) => item.id === state.workId)) throw new Error(`Koishi adapter did not find ${state.workId}.`)
  const detail = await adapter.getWork(state.workId)
  if (!detail || !detail.media.length) throw new Error(`Koishi adapter could not retrieve ${state.workId}.`)
  let fetchedBytes = 0
  for (const media of detail.media) {
    try {
      const bytes = await adapter.fetchMedia(media)
      if (bytes.byteLength) {
        fetchedBytes = bytes.byteLength
        break
      }
    } catch {
      // A separate failed-media fixture may intentionally make one item unavailable.
    }
  }
  if (!fetchedBytes) throw new Error('Koishi adapter could not fetch any non-empty Media body.')
  const sent = []
  await sendPayloadWork({ send: async (message) => { sent.push(message) } }, adapter, state.workId)
  if (!sent.length || !sent.every((message) => message?.attrs?.forward === true)) throw new Error('Koishi adapter did not create a merged-forward delivery.')
  return `Koishi adapter authenticated, retrieved ${state.workId}, fetched ${fetchedBytes} byte(s), and built ${sent.length} merged-forward message(s).`
}

async function runKoishiFailureCheck(config, state, fetchImpl, now) {
  let PayloadArchiveReadAdapter, sendPayloadWork
  try {
    ({ PayloadArchiveReadAdapter, sendPayloadWork } = require('../plugins/memebot-archive/lib/payload-read.js'))
  } catch {
    throw new Error('Build koishi-plugin-memebot-archive before enabling the failed-media Koishi check.')
  }
  const adapter = new PayloadArchiveReadAdapter({
    baseUrl: config.siteUrl,
    serviceToken: config.token,
    timeoutMs: config.timeoutMs,
  }, { fetch: fetchImpl, now })
  const detail = await adapter.getWork(state.workId)
  if (!detail || detail.media.length < 2) throw new Error('The failed-media fixture must leave at least one successful Media item.')
  const failedId = mediaIdFromUrl(config.failedMediaUrl)
  if (!failedId || !detail.media.some((media) => media.id === failedId)) throw new Error('Failed Media URL does not belong to the configured Work.')
  let failures = 0
  let successes = 0
  for (const media of detail.media) {
    try {
      const bytes = await adapter.fetchMedia(media)
      if (bytes.byteLength) successes += 1
    } catch {
      failures += 1
    }
  }
  if (failures !== 1 || successes < 1) throw new Error(`Expected one failed Media and at least one successful item; observed ${failures} failure(s), ${successes} success(es).`)
  const sent = []
  await sendPayloadWork({ send: async (message) => { sent.push(message) } }, adapter, state.workId)
  const children = sent.flatMap((message) => Array.isArray(message?.children) ? message.children : [])
  const hasFailureMessage = children.some((node) => typeof node?.children === 'string' && /获取失败/.test(node.children))
  if (!hasFailureMessage || !sent.length) throw new Error('Koishi merged-forward delivery did not report the failed item.')
  return 'Koishi kept successful Media in merged-forward delivery and reported the one failed item.'
}

async function runKoishiOutageCheck(config, fetchImpl, now) {
  let PayloadArchiveReadAdapter
  try {
    ({ PayloadArchiveReadAdapter } = require('../plugins/memebot-archive/lib/payload-read.js'))
  } catch {
    throw new Error('Build koishi-plugin-memebot-archive before enabling the outage Koishi check.')
  }
  const outage = normalizeUrls(config.outageUrl)
  const adapter = new PayloadArchiveReadAdapter({
    baseUrl: outage.siteUrl,
    serviceToken: config.token,
    timeoutMs: config.timeoutMs,
  }, { fetch: fetchImpl, now })
  try {
    await adapter.searchWorks()
    throw new Error('Koishi adapter did not report the Payload outage as unavailable.')
  } catch (error) {
    if (error?.kind !== 'unavailable') throw error
  }
  return 'Koishi maps the Payload outage to its temporary-unavailable result.'
}

async function runKoishiExpiryCheck(config, state, fetchImpl, now) {
  let PayloadArchiveReadAdapter
  try {
    ({ PayloadArchiveReadAdapter } = require('../plugins/memebot-archive/lib/payload-read.js'))
  } catch {
    throw new Error('Build koishi-plugin-memebot-archive before enabling the expiry Koishi check.')
  }
  const adapter = new PayloadArchiveReadAdapter({
    baseUrl: config.siteUrl,
    serviceToken: config.token,
    timeoutMs: config.timeoutMs,
  }, { fetch: fetchImpl, now })
  const media = state.mediaForChecks || state.detail?.media?.[0]
  if (!media) throw new Error('No Media is available for the Koishi expiry check.')
  const expired = {
    ...media,
    access: { ...media.access, expiresAt: new Date(now() - 1_000).toISOString() },
  }
  try {
    await adapter.fetchMedia(expired)
    throw new Error('Koishi adapter fetched Media after its signed access expired.')
  } catch (error) {
    if (error?.kind !== 'media') throw error
  }
  return 'Koishi maps expired protected Media to an individual media failure.'
}

async function runStagingSmoke(config, options = {}) {
  const checks = []
  if (!config || !config.enabled) {
    const status = config?.required ? 'failed' : 'not-executed'
    addCheck(checks, 'configuration', status, config?.reason === 'invalid-url' ? 'Staging URL is invalid.' : 'Staging URL/token are not configured.')
    return { status, checks }
  }

  const fetchImpl = options.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    addCheck(checks, 'configuration', 'failed', 'Global fetch is unavailable.')
    return { status: 'failed', checks }
  }
  const now = options.now || (() => Date.now())
  const savedPersistence = readPersistenceState(config)
  const state = { workId: savedPersistence?.workId || config.workId, detail: undefined, mediaForChecks: undefined }

  await check(checks, 'health', async () => {
    const { response, body } = await requestJson(fetchImpl, siteUrl(config, '/api/health'), { headers: { accept: 'application/json' } }, config.timeoutMs)
    if (!response.ok || body?.status !== 'ok') throw new Error(`Health returned HTTP ${response.status}.`)
    return 'Payload and R2 health endpoint is ready.'
  })

  if (config.directMediaUrl) {
    await check(checks, 'private-r2', async () => {
      const response = await request(fetchImpl, config.directMediaUrl, { headers: { accept: '*/*' } }, config.timeoutMs)
      if (![401, 403].includes(response.status)) throw new Error(`Anonymous direct R2 access returned HTTP ${response.status}; expected 401 or 403 for an existing object.`)
      return 'Anonymous direct R2 access is denied.'
    })
  } else if (config.requirePrivacy) {
    addCheck(checks, 'private-r2', 'failed', 'Set MEMEBOT_ARCHIVE_STAGING_DIRECT_MEDIA_URL to an object URL for the anonymous privacy check.')
  } else {
    skip(checks, 'private-r2', 'Set MEMEBOT_ARCHIVE_STAGING_DIRECT_MEDIA_URL to prove that a direct R2 object URL is not public.')
  }

  if (config.createFixture) {
    if (config.adminEmail && config.adminPassword) {
      const created = await check(checks, 'admin-upload', async () => {
        const fixture = await createAdminFixture(config, fetchImpl, now)
        state.workId = fixture.workId
        return `Created ${fixture.workId} through Payload Admin API.`
      })
      if (!created) state.workId = undefined
    } else {
      addCheck(checks, 'admin-upload', 'failed', 'Fixture creation requires the deployment-only Admin credentials.')
    }
  } else if (config.requireAdmin) {
    addCheck(checks, 'admin-upload', 'failed', 'The full staging acceptance requires Payload Admin fixture creation.')
  } else {
    skip(checks, 'admin-upload', 'Provide MEMEBOT_ARCHIVE_STAGING_CREATE_FIXTURE=1 with Admin credentials, or create a Work manually and record its W<n> id.')
  }

  const invalidPassed = await check(checks, 'invalid-credential', async () => {
    const { response } = await requestJson(fetchImpl, apiUrl(config, 'works'), { headers: jsonHeaders('wrong-token') }, config.timeoutMs)
    if (response.status !== 401 && response.status !== 403) throw new Error(`Expected 401/403, got HTTP ${response.status}.`)
    return 'Invalid machine credentials are rejected.'
  })
  if (!invalidPassed) return finalize(config, checks)

  if (!state.workId) {
    addCheck(checks, 'machine-read', 'failed', missingCoreMessage(config))
    skip(checks, 'private-media', 'No Work is available for the media checks.')
    skip(checks, 'expired-media', 'No Work is available for the media checks.')
  } else {
    const readPassed = await check(checks, 'machine-read', async () => {
      const url = new URL(apiUrl(config, 'works'))
      url.searchParams.set('query', state.workId)
      const { response, body } = await requestJson(fetchImpl, url, { headers: jsonHeaders(config.token) }, config.timeoutMs)
      if (!response.ok) throw new Error(`Search returned HTTP ${response.status}.`)
      if (!Array.isArray(body?.data) || !Number.isSafeInteger(Number(body.total))) throw new Error('Search response must contain data and an exact total.')
      const found = body.data.some((item) => normalizeWorkId(item?.id) === state.workId)
      if (!found) throw new Error(`${state.workId} was not returned by the staging search.`)
      return `Search returned ${body.total} matching Work(s).`
    })
    if (readPassed) {
      await check(checks, 'work-detail', async () => {
        const { response, body } = await requestJson(fetchImpl, apiUrl(config, `works/${encodeURIComponent(state.workId)}`), { headers: jsonHeaders(config.token) }, config.timeoutMs)
        if (!response.ok) throw new Error(`Detail returned HTTP ${response.status}.`)
        state.detail = archiveWork(body)
        return `${state.detail.id} has ${state.detail.media.length} ordered Media item(s).`
      })
    } else {
      skip(checks, 'work-detail', 'Search did not return the configured Work.')
    }

    if (state.detail) {
      await check(checks, 'private-media', async () => {
        let lastError
        for (const media of state.detail.media) {
          try {
            const mediaUrl = protectedMediaUrl(config, media)
            const response = await request(fetchImpl, mediaUrl, { headers: { accept: media.contentType } }, config.timeoutMs)
            if (!response.ok) throw new Error(`Protected Media returned HTTP ${response.status}.`)
            const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
            if (contentType && contentType !== String(media.contentType).toLowerCase()) throw new Error(`Protected Media returned ${contentType}, expected ${media.contentType}.`)
            if (!(await response.arrayBuffer()).byteLength) throw new Error('Protected Media returned an empty body.')
            state.mediaForChecks = media
            return 'R2 bytes are delivered through the signed Payload endpoint.'
          } catch (error) {
            lastError = error
          }
        }
        throw lastError || new Error('No Media descriptor was available.')
      })
      if (config.mediaSigningSecret) {
        await check(checks, 'expired-media', async () => {
          const media = state.mediaForChecks || state.detail.media[0]
          const response = await request(fetchImpl, expiredMediaUrl(config, media, now), {}, config.timeoutMs)
          if (response.status !== 401 && response.status !== 403) throw new Error(`Expected expired access to return 401/403, got HTTP ${response.status}.`)
          if (config.runKoishi) await runKoishiExpiryCheck(config, state, fetchImpl, now)
          return config.runKoishi
            ? 'A correctly signed but expired Media URL is rejected and Koishi reports an individual media failure.'
            : 'A correctly signed but expired Media URL is rejected.'
        })
      } else if (config.requireMediaExpiry) {
        addCheck(checks, 'expired-media', 'failed', 'Set MEMEBOT_ARCHIVE_STAGING_MEDIA_SIGNING_SECRET to mint a correctly signed expired URL.')
      } else {
        skip(checks, 'expired-media', 'Set MEMEBOT_ARCHIVE_STAGING_MEDIA_SIGNING_SECRET to test expiry with a valid signature.')
      }
      if (config.runKoishi) {
        await check(checks, 'koishi-client', async () => runKoishiClientCheck(config, state, fetchImpl, now))
      } else if (config.requireKoishi) {
        addCheck(checks, 'koishi-client', 'failed', 'The full staging acceptance requires MEMEBOT_ARCHIVE_STAGING_KOISHI=1.')
      } else {
        skip(checks, 'koishi-client', 'Set MEMEBOT_ARCHIVE_STAGING_KOISHI=1 after building the memebot-archive plugin to exercise the real adapter.')
      }
      if (config.stateFile) {
        await check(checks, 'redeploy-persistence', async () => {
          if (savedPersistence?.error) throw new Error(`Saved persistence state is invalid: ${savedPersistence.error}`)
          if (savedPersistence) {
            if (savedPersistence.workId !== state.detail.id) throw new Error(`Expected ${savedPersistence.workId} after redeploy, found ${state.detail.id}.`)
            const mediaIds = state.detail.media.map((media) => String(media.id))
            if (JSON.stringify(savedPersistence.mediaIds) !== JSON.stringify(mediaIds)) throw new Error('Work or Media ordering changed after redeploy.')
            return `${state.detail.id} matches the saved pre-redeploy Work and Media order.`
          }
          writePersistenceState(config, state.detail)
          return 'Saved a baseline; rerun after restart/redeploy to verify persistence.'
        })
      }
    }
  }

  if (config.afterUrl) {
    await check(checks, 'redeploy-persistence', async () => {
      const after = normalizeUrls(config.afterUrl)
      if (!state.workId || !state.detail) throw new Error('A Work must pass the first staging read before comparing a redeploy.')
      const url = new URL(`${after.apiUrl}works/${encodeURIComponent(state.workId)}`)
      const { response, body } = await requestJson(fetchImpl, url, { headers: jsonHeaders(config.token) }, config.timeoutMs)
      if (!response.ok) throw new Error(`Post-redeploy detail returned HTTP ${response.status}.`)
      const detail = archiveWork(body)
      const beforeIds = state.detail.media.map((media) => String(media.id))
      const afterIds = detail.media.map((media) => String(media.id))
      if (detail.id !== state.detail.id || JSON.stringify(afterIds) !== JSON.stringify(beforeIds)) throw new Error('Work or Media ordering changed after redeploy.')
      return `${state.workId} remains readable with the same Media order after redeploy.`
    })
  } else if (!config.stateFile) {
    skip(checks, 'redeploy-persistence', 'Set MEMEBOT_ARCHIVE_STAGING_AFTER_URL after restarting or redeploying the isolated service.')
  }

  if (config.outageUrl) {
    await check(checks, 'payload-outage', async () => {
      const outage = normalizeUrls(config.outageUrl)
      try {
        const { response } = await requestJson(fetchImpl, `${outage.apiUrl}works`, { headers: jsonHeaders(config.token) }, config.timeoutMs)
        if (response.status < 500) throw new Error(`Expected an unavailable response, got HTTP ${response.status}.`)
      } catch (error) {
        if (/Expected an unavailable response/.test(errorMessage(error))) throw error
      }
      if (config.runKoishi) await runKoishiOutageCheck(config, fetchImpl, now)
      return config.runKoishi
        ? 'Payload outage produces a temporary-unavailable boundary and Koishi unavailable result.'
        : 'Payload outage produces a temporary-unavailable boundary.'
    })
  } else if (config.requireFailureFixtures) {
    addCheck(checks, 'payload-outage', 'failed', 'The full staging acceptance requires MEMEBOT_ARCHIVE_STAGING_OUTAGE_URL.')
  } else {
    skip(checks, 'payload-outage', 'Set MEMEBOT_ARCHIVE_STAGING_OUTAGE_URL to a deliberately stopped or isolated endpoint.')
  }

  if (config.failedMediaUrl) {
    await check(checks, 'failed-media', async () => {
      const response = await request(fetchImpl, config.failedMediaUrl, {}, config.timeoutMs)
      if (response.ok) throw new Error('Expected the configured failed Media fixture to return a non-2xx response.')
      if (config.requireFailureFixtures && !config.failedMediaWorkId) throw new Error('Set MEMEBOT_ARCHIVE_STAGING_FAILED_MEDIA_WORK_ID for the full failed-media acceptance.')
      const failedWorkId = config.failedMediaWorkId || state.workId
      let failedWorkDetail = state.detail
      if (failedWorkId && failedWorkId !== state.workId) {
        const { response: detailResponse, body } = await requestJson(fetchImpl, apiUrl(config, `works/${encodeURIComponent(failedWorkId)}`), { headers: jsonHeaders(config.token) }, config.timeoutMs)
        if (!detailResponse.ok) throw new Error(`Failed-media Work became unreadable (HTTP ${detailResponse.status}).`)
        failedWorkDetail = archiveWork(body)
      } else if (failedWorkId) {
        const { response: detailResponse, body } = await requestJson(fetchImpl, apiUrl(config, `works/${encodeURIComponent(failedWorkId)}`), { headers: jsonHeaders(config.token) }, config.timeoutMs)
        if (!detailResponse.ok) throw new Error(`Work became unreadable after the failed Media fixture (HTTP ${detailResponse.status}).`)
        failedWorkDetail = archiveWork(body)
      }
      if (!failedWorkDetail || failedWorkDetail.media.length < 2) throw new Error('The failed-media Work must remain readable with at least two Media items.')
      const failedId = mediaIdFromUrl(config.failedMediaUrl)
      if (!failedId || !failedWorkDetail.media.some((media) => media.id === failedId)) throw new Error('Failed Media URL does not belong to the failed-media Work.')
      let failures = 1
      let successes = 0
      for (const media of failedWorkDetail.media) {
        if (media.id === failedId) continue
        const mediaUrl = protectedMediaUrl(config, media)
        const mediaResponse = await request(fetchImpl, mediaUrl, { headers: { accept: media.contentType } }, config.timeoutMs)
        if (!mediaResponse.ok) failures += 1
        else if ((await mediaResponse.arrayBuffer()).byteLength) successes += 1
      }
      if (failures !== 1 || successes < 1) throw new Error(`Expected one failed Media and at least one successful item; observed ${failures} failure(s), ${successes} success(es).`)
      if (config.runKoishi) return runKoishiFailureCheck(config, { ...state, workId: failedWorkId, detail: failedWorkDetail }, fetchImpl, now)
      return `Failed Media fixture returned HTTP ${response.status} without hiding the Work.`
    })
  } else if (config.requireFailureFixtures) {
    addCheck(checks, 'failed-media', 'failed', 'The full staging acceptance requires MEMEBOT_ARCHIVE_STAGING_FAILED_MEDIA_URL.')
  } else {
    skip(checks, 'failed-media', 'Set MEMEBOT_ARCHIVE_STAGING_FAILED_MEDIA_URL to a signed URL whose object was intentionally removed.')
  }

  return finalize(config, checks)
}

function finalize(config, checks) {
  const failed = checks.some((check) => check.status === 'failed')
  const status = failed ? 'failed' : 'passed'
  return { status, checks, siteUrl: config.siteUrl }
}

function formatStagingReport(result) {
  const label = result.status === 'not-executed' ? 'NOT EXECUTED' : result.status.toUpperCase()
  const lines = [`Archive staging smoke: ${label}`]
  for (const check of result.checks || []) {
    lines.push(`- ${check.name}: ${check.status.toUpperCase()}${check.message ? ` - ${check.message}` : ''}`)
  }
  return lines.join('\n')
}

module.exports = { buildStagingConfig, formatStagingReport, runStagingSmoke }

if (require.main === module) {
  const config = buildStagingConfig(process.env, process.argv)
  runStagingSmoke(config)
    .then((result) => {
      process.stdout.write(`${formatStagingReport(result)}\n`)
      if (result.status === 'failed') process.exitCode = 1
    })
    .catch((error) => {
      process.stderr.write(`Archive staging smoke failed: ${errorMessage(error)}\n`)
      process.exitCode = 1
    })
}
