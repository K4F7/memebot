import type { CollectionConfig } from 'payload'

export const Users: CollectionConfig = {
  slug: 'users',
  labels: {
    singular: '用户',
    plural: '用户',
  },
  admin: {
    group: '系统管理',
    useAsTitle: 'email',
    description: 'Archive 管理员账号。',
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
