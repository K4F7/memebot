import type { CollectionConfig } from 'payload'

import { relationId } from '../archive/relations'

const archiveIdentifier = /^W[1-9]\d*$/

async function allocateArchiveIdentifier(req: any): Promise<string> {
  // D1 can atomically increment the sequence even when several admin requests arrive together.
  const client = req.payload.db?.drizzle?.$client
  if (client) {
    await client.prepare('INSERT OR IGNORE INTO archive_sequences (id, value) VALUES (?, ?)').bind(1, 0).run()
    const row = await client.prepare('UPDATE archive_sequences SET value = value + 1 WHERE id = ? RETURNING value').bind(1).first()
    if (row && Number((row as any).value) > 0) return `W${Number((row as any).value)}`
  }
  const sequence = await req.payload.findByID({
    collection: 'archive-sequences',
    id: 1,
    overrideAccess: true,
  }).catch((): undefined => undefined)
  const next = Math.max(1, Number(sequence?.value || 0) + 1)
  if (sequence) {
    await req.payload.update({ collection: 'archive-sequences', id: 1, data: { value: next }, overrideAccess: true })
  } else {
    await req.payload.create({ collection: 'archive-sequences', data: { id: 1, value: next }, overrideAccess: true })
  }
  return `W${next}`
}

export const Works: CollectionConfig = {
  slug: 'works',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['archiveId', 'title', 'author', 'updatedAt'],
  },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  hooks: {
    beforeValidate: [async ({ data, operation, originalDoc, req }) => {
      const next = { ...((originalDoc || {}) as Record<string, unknown>), ...(data || {}) } as Record<string, unknown>
      if (operation === 'create') next.archiveId = await allocateArchiveIdentifier(req)
      const id = String(next.archiveId || '').trim().toUpperCase()
      if (!archiveIdentifier.test(id)) throw new Error('Archive Identifier 必须是 W<n>。')
      next.archiveId = id
      next.title = String(next.title || '').trim()
      next.author = String(next.author || '').trim()
      if (!next.title || !next.author) throw new Error('Work 标题和作者不能为空。')
      if (next.description !== undefined) next.description = String(next.description).trim() || undefined
      return next
    }],
  },
  fields: [
    {
      name: 'archiveId',
      type: 'text',
      required: true,
      unique: true,
      admin: { readOnly: true, description: '稳定且永不复用的 Archive Identifier' },
      validate: (value: unknown) => archiveIdentifier.test(String(value || '').toUpperCase()) || 'Archive Identifier 必须是 W<n>。',
    },
    { name: 'title', type: 'text', required: true },
    { name: 'author', type: 'text', required: true },
    { name: 'description', type: 'textarea' },
  ],
}

export { archiveIdentifier, relationId }
