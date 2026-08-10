import type { CollectionConfig } from 'payload'
import { sql } from '@payloadcms/db-postgres'

import { relationId } from '../archive/relations'

const archiveIdentifier = /^W[1-9]\d*$/

async function allocateArchiveIdentifier(req: any): Promise<string> {
  const drizzle = req.payload.db?.drizzle
  if (drizzle) {
    await drizzle.execute(sql`INSERT INTO archive_sequences (id, value) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`)
    const result = await drizzle.execute(sql`UPDATE archive_sequences SET value = value + 1, updated_at = now() WHERE id = 1 RETURNING value`)
    const value = Number((result.rows?.[0] as any)?.value)
    if (value > 0) return `W${value}`
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
  labels: {
    singular: { en: 'Work', zh: '作品' },
    plural: { en: 'Works', zh: '作品' },
  },
  admin: {
    group: { en: 'Archive', zh: '档案管理' },
    useAsTitle: 'title',
    defaultColumns: ['archiveId', 'title', 'author', 'updatedAt'],
    description: {
      en: 'Archived works. A work is readable when it has Work Media pointing to active Media.',
      zh: '档案作品。可读性取决于是否存在指向未撤回 Media 的 WorkMedia。',
    },
  },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: () => false,
  },
  hooks: {
    beforeValidate: [async ({ data, operation, originalDoc, req }) => {
      const next = { ...((originalDoc || {}) as Record<string, unknown>), ...(data || {}) } as Record<string, unknown>
      if (operation === 'create') next.archiveId = await allocateArchiveIdentifier(req)
      else if (originalDoc?.archiveId) next.archiveId = originalDoc.archiveId
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
      label: { en: 'Archive ID', zh: '档案编号' },
      admin: {
        readOnly: true,
        description: {
          en: 'A stable Archive Identifier that is never reused.',
          zh: '稳定且永不复用的 Archive Identifier',
        },
      },
      validate: (value: unknown) => archiveIdentifier.test(String(value || '').toUpperCase()) || 'Archive Identifier 必须是 W<n>。',
    },
    { name: 'title', type: 'text', required: true, label: { en: 'Title', zh: '标题' } },
    { name: 'author', type: 'text', required: true, label: { en: 'Author', zh: '作者' } },
    { name: 'description', type: 'textarea', label: { en: 'Description', zh: '描述' } },
  ],
}

export { archiveIdentifier, relationId }
