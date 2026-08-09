const textEncoder = new TextEncoder()

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const buffer = (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer
  const encoded = buffer
    ? buffer.from(input).toString('base64')
    : btoa(String.fromCharCode(...input))
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function digest(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base64Url(await crypto.subtle.sign('HMAC', key, textEncoder.encode(value)))
}

export async function signMediaAccess(secret: string, mediaId: string, expires: number): Promise<string> {
  return digest(secret, `${mediaId}.${expires}`)
}

export async function verifyMediaAccess(
  secret: string,
  mediaId: string,
  expires: number,
  signature: string,
  now = Date.now(),
): Promise<boolean> {
  if (!secret || !Number.isSafeInteger(expires) || expires * 1000 <= now) return false
  const expected = await signMediaAccess(secret, mediaId, expires)
  return expected === signature
}

export function mediaAccessExpiry(now = Date.now(), ttlSeconds = 60): number {
  const ttl = Math.max(1, Math.min(300, Math.floor(ttlSeconds) || 60))
  return Math.floor(now / 1000) + ttl
}
