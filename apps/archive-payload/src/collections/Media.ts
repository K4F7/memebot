import type { CollectionConfig } from 'payload'

import { relationId } from '../archive/relations'
import { createR2MediaEndpoint } from '../archive/r2-payload-storage'
import { ensureMediaStorageKey, MAX_MEDIA_SIZE, verifyUploadContext } from '../archive/media-policy'
import { ALLOWED_MEDIA_TYPES, validateMediaMimeType } from '../archive/mime'

export const Media: CollectionConfig = {
  slug: 'media',
  admin: { useAsTitle: 'filename', defaultColumns: ['filename', 'mimeType', 'filesize', 'work'] },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    // MVP keeps media records auditable; withdrawing a Work/Media item is a
    // metadata operation and must not physically delete the R2 object.
    delete: () => false,
  },
  endpoints: [{ path: '/file/:id', method: 'get', handler: createR2MediaEndpoint() }],
  hooks: {
    beforeOperation: [({ args, operation, req }) => {
      // Payload's default filename de-duplicator only checks `filename`.
      // Client uploads already have an opaque storage identity, so preserve
      // the submitted display filename for this production storage path.
      if (operation === 'create' && req.file?.clientUploadContext !== undefined) {
        return { ...args, overwriteExistingFiles: true }
      }
      return args
    }],
    beforeValidate: [({ data, operation, originalDoc, req }) => {
      if (operation === 'update' && req.file) throw new Error('MVP 不支持替换已保存 Media 的文件；请创建新的 Media。')
      const originalWork = relationId((originalDoc as any)?.work)
      const nextWork = relationId((data as any)?.work) || originalWork
      if (originalWork && nextWork !== originalWork) throw new Error('Media 所属 Work 创建后不可修改。')
      if ((originalDoc as any)?.withdrawnAt) {
        const previous = String((originalDoc as any).withdrawnAt)
        const requested = Object.prototype.hasOwnProperty.call(data || {}, 'withdrawnAt') ? String((data as any)?.withdrawnAt || '') : previous
        if (requested !== previous) throw new Error('已撤回 Media 不支持恢复或修改撤回时间。')
        ;(data as any).withdrawnAt = (originalDoc as any).withdrawnAt
      }
      const clientContext = (req.file as any)?.clientUploadContext === undefined
        ? undefined
        : verifyUploadContext((req.file as any).clientUploadContext)
      if ((req.file as any)?.clientUploadContext !== undefined && !clientContext) throw new Error('Media client upload context 无效或已过期。')
      if (clientContext) {
        ;(data as any).mimeType = clientContext.mimeType
        ;(data as any).filesize = clientContext.filesize
      }
      const mimeType = clientContext?.mimeType || (req.file as any)?.mimetype || (data as any)?.mimeType
      if (mimeType) validateMediaMimeType(mimeType)
      const size = Number((req.file as any)?.size || (data as any)?.filesize || 0)
      if (size > MAX_MEDIA_SIZE) throw new Error('Media 文件不能超过 100 MB。')
      return ensureMediaStorageKey({
        data: data as Record<string, any> | undefined,
        originalDoc: originalDoc as Record<string, any> | undefined,
        req: req as any,
      })
    }],
  },
  upload: {
    // Payload otherwise makes filename globally unique. Pairing it with the
    // opaque object identity keeps display names repeatable without changing
    // the storage identity contract.
    filenameCompoundIndex: ['filename', 'storageKey'],
    mimeTypes: [...ALLOWED_MEDIA_TYPES],
    skipSafeFetch: true,
    crop: false,
    focalPoint: false,
  },
  fields: [
    {
      name: 'work',
      type: 'relationship',
      relationTo: 'works',
      required: true,
      admin: { description: '每个 Media Item 必须属于且仅属于一个 Work。' },
    },
    {
      name: 'storageKey',
      type: 'text',
      required: true,
      unique: true,
      admin: { hidden: true, readOnly: true },
    },
    { name: 'alt', type: 'text' },
    {
      name: 'withdrawnAt',
      type: 'date',
      admin: { description: '填写后从 Archive 读 API 隐藏，但保留元数据和 R2 对象。' },
    },
  ],
}
