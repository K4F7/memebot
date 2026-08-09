import type { CollectionConfig } from 'payload'

export const ArchiveSequences: CollectionConfig = {
  slug: 'archive-sequences',
  admin: { hidden: true },
  access: {
    read: () => false,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'value', type: 'number', required: true, min: 0 },
  ],
}
