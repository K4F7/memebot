import type { CollectionConfig } from 'payload'

export const Users: CollectionConfig = {
  slug: 'users',
  labels: {
    singular: { en: 'User', zh: '用户' },
    plural: { en: 'Users', zh: '用户' },
  },
  admin: {
    group: { en: 'System', zh: '系统管理' },
    useAsTitle: 'email',
    description: {
      en: 'Administrator accounts for the Archive.',
      zh: 'Archive 管理员账号。',
    },
  },
  auth: true,
  fields: [],
  access: {
    read: ({ req }) => Boolean(req.user),
    // Payload's first-run Admin screen needs one bootstrap account; after that only
    // authenticated administrators may add accounts.
    create: async ({ req }) => {
      if (req.user) return true
      const existing = await req.payload.find({ collection: 'users', limit: 1, pagination: false, overrideAccess: true })
      return existing.totalDocs === 0
    },
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  versions: false,
}
