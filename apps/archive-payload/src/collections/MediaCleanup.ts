import type { CollectionConfig } from 'payload'

export const MediaCleanup: CollectionConfig = {
  slug: 'media-cleanups',
  admin: {
    hidden: true,
  },
  access: {
    read: () => false,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'work', type: 'relationship', relationTo: 'works', required: true },
    { name: 'mediaId', type: 'text', required: true },
    { name: 'storageKey', type: 'text', required: true, unique: true },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      options: [
        { label: 'Pending', value: 'pending' },
        { label: 'Deleted', value: 'deleted' },
        { label: 'Failed', value: 'failed' },
      ],
    },
    { name: 'attempts', type: 'number', required: true, defaultValue: 0 },
    { name: 'lastError', type: 'textarea' },
  ],
}
