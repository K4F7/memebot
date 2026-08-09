import type { CollectionConfig } from 'payload'

import { relationId } from '../archive/relations'

export const WorkMedia: CollectionConfig = {
  slug: 'work-media',
  admin: { useAsTitle: 'id', defaultColumns: ['work', 'media', 'displayOrder', 'caption'] },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  hooks: {
    beforeValidate: [async ({ data, originalDoc, req }) => {
      const workId = relationId((data as any)?.work) || relationId((originalDoc as any)?.work)
      const mediaId = relationId((data as any)?.media) || relationId((originalDoc as any)?.media)
      if (!workId || !mediaId) throw new Error('WorkMedia 必须同时指定 Work 和 Media。')
      const media = await req.payload.findByID({ collection: 'media', id: mediaId, depth: 0, overrideAccess: true })
      if (!media || relationId(media.work) !== workId) throw new Error('Media 只能关联到其所属的 Work。')
      const existing = await req.payload.find({
        collection: 'work-media',
        depth: 0,
        limit: 2,
        pagination: false,
        overrideAccess: true,
        where: { media: { equals: mediaId } },
      })
      const duplicate = (existing.docs || []).some((item: any) => String(item.id) !== String((originalDoc as any)?.id || ''))
      if (duplicate) throw new Error('Media 已经属于另一个 WorkMedia 关系。')
      const next = { ...((originalDoc || {}) as Record<string, unknown>), ...(data || {}) } as Record<string, unknown>
      next.displayOrder = Math.max(0, Math.floor(Number(next.displayOrder ?? originalDoc?.displayOrder ?? 0)))
      if (next.caption !== undefined) next.caption = String(next.caption).trim() || undefined
      return next
    }],
  },
  fields: [
    { name: 'work', type: 'relationship', relationTo: 'works', required: true },
    { name: 'media', type: 'relationship', relationTo: 'media', required: true, unique: true },
    { name: 'displayOrder', type: 'number', required: true, defaultValue: 0, min: 0 },
    { name: 'caption', type: 'text' },
  ],
}
