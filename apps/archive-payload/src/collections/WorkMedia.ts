import type { CollectionConfig } from 'payload'
import { sql } from '@payloadcms/db-postgres'

import { relationId } from '../archive/relations'

async function normalizeWorkMediaOrder(req: any, workId: string, relationshipId: unknown): Promise<number | undefined> {
  const numericWorkId = Number(workId)
  if (!Number.isSafeInteger(numericWorkId)) throw new Error('Work ID 必须是有效的整数。')
  const numericRelationshipId = Number(relationshipId)
  if (!Number.isSafeInteger(numericRelationshipId)) return undefined

  const adapter = req.payload.db as any
  const transactionID = req.transactionID ? await req.transactionID : undefined
  const transaction = transactionID ? adapter.sessions?.[transactionID]?.db : undefined
  const normalize = async (db: any): Promise<number | undefined> => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`memebot:work-media:${numericWorkId}`}))`)
    await db.execute(sql`
      WITH ranked AS (
        SELECT id, row_number() OVER (ORDER BY display_order, id) - 1 AS normalized
        FROM work_media
        WHERE work_id = ${numericWorkId}
      )
      UPDATE work_media AS work_media
      SET display_order = -ranked.normalized - 1
      FROM ranked
      WHERE work_media.id = ranked.id
    `)
    await db.execute(sql`
      WITH ranked AS (
        SELECT id, row_number() OVER (ORDER BY display_order DESC, id) - 1 AS normalized
        FROM work_media
        WHERE work_id = ${numericWorkId}
      )
      UPDATE work_media AS work_media
      SET display_order = ranked.normalized
      FROM ranked
      WHERE work_media.id = ranked.id
    `)
    const result = await db.execute(sql`
      SELECT display_order
      FROM work_media
      WHERE id = ${numericRelationshipId} AND work_id = ${numericWorkId}
    `)
    const displayOrder = Number(result.rows?.[0]?.display_order)
    return Number.isFinite(displayOrder) ? displayOrder : undefined
  }

  if (transaction) {
    return normalize(transaction)
  } else if (adapter.drizzle?.transaction) {
    return adapter.drizzle.transaction(normalize)
  }
  return undefined
}

export const WorkMedia: CollectionConfig = {
  slug: 'work-media',
  labels: {
    singular: { en: 'Work Media', zh: '作品媒体' },
    plural: { en: 'Work Media', zh: '作品媒体' },
  },
  admin: {
    group: { en: 'Archive', zh: '档案管理' },
    useAsTitle: 'id',
    defaultColumns: ['work', 'media', 'displayOrder', 'caption'],
    description: {
      en: 'Media presentation relationships for a Work, including display order and an optional caption.',
      zh: 'Work 的媒体呈现关系，承载显示顺序与可选 caption。',
    },
  },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user && (req as any).context?.workAuthoring),
    update: ({ req }) => Boolean(req.user && (req as any).context?.workAuthoring),
    delete: () => false,
  },
  hooks: {
    beforeValidate: [async ({ data, originalDoc, req }) => {
      const workId = relationId((data as any)?.work) || relationId((originalDoc as any)?.work)
      const mediaId = relationId((data as any)?.media) || relationId((originalDoc as any)?.media)
      if (!workId || !mediaId) throw new Error('WorkMedia 必须同时指定 Work 和 Media。')
      const media = await req.payload.findByID({ collection: 'media', id: mediaId, depth: 0, overrideAccess: true })
      if (!media || relationId(media.work) !== workId) throw new Error('Media 只能关联到其所属的 Work。')
      if ((media as any).withdrawnAt) throw new Error('已撤回的 Media 不能重新关联。')
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
    afterChange: [async ({ doc, req }) => {
      const workId = relationId((doc as any)?.work)
      if (!workId) return doc
      const displayOrder = await normalizeWorkMediaOrder(req, workId, (doc as any)?.id)
      return displayOrder === undefined ? doc : { ...doc, displayOrder }
    }],
  },
  fields: [
    { name: 'work', type: 'relationship', relationTo: 'works', required: true, label: { en: 'Work', zh: '作品' } },
    { name: 'media', type: 'relationship', relationTo: 'media', required: true, unique: true, label: { en: 'Media', zh: '媒体' } },
    {
      name: 'displayOrder',
      type: 'number',
      required: true,
      defaultValue: 0,
      min: 0,
      label: { en: 'Display order', zh: '显示顺序' },
    },
    { name: 'caption', type: 'text', label: { en: 'Caption', zh: '说明文字' } },
  ],
}
