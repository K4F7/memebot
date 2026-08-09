import type { CollectionConfig } from 'payload'

import { ALLOWED_MEDIA_TYPES, validateMediaMimeType } from '../archive/mime'

export const Media: CollectionConfig = {
  slug: 'media',
  admin: { useAsTitle: 'filename', defaultColumns: ['filename', 'mimeType', 'filesize', 'work'] },
  access: {
    read: ({ req }) => Boolean(req.user),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  hooks: {
    beforeValidate: [({ data, req }) => {
      const mimeType = (req.file as any)?.mimetype || (data as any)?.mimeType
      if (mimeType) validateMediaMimeType(mimeType)
      const size = Number((req.file as any)?.size || (data as any)?.filesize || 0)
      if (size > 100 * 1024 * 1024) throw new Error('Media 文件不能超过 100 MB。')
      return data
    }],
  },
  upload: {
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
    { name: 'alt', type: 'text' },
  ],
}
