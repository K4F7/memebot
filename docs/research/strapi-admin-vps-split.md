# Strapi Admin on Vercel with a VPS API

Date: 2026-08-17

## Question

Can Strapi 5's built-in Admin panel be deployed separately on Vercel while the Strapi API, database access, authentication, and local media storage run on a VPS?

## Finding

Yes. Strapi 5 documents a split-server deployment in which `server.url` is the absolute public URL of the backend, `admin.url` is `/`, and `admin.serveAdminPanel` is `false`. The Admin bundle is built and hosted separately, while its API requests target the backend. Configuration that affects these URLs requires a new Admin build.

The supported first-version topology is therefore:

```text
Vercel: prebuilt Strapi Admin static assets
                    |
                    | HTTPS + credentialed CORS
                    v
VPS: Strapi API + authentication + upload provider
     PostgreSQL + persistent local media volume
```

The VPS remains responsible for uploads. Strapi's local upload provider writes to the server filesystem; Vercel must not be treated as persistent media storage.

## Constraints

- Use stable HTTPS origins for both Admin and API. Strapi 5.24 and later uses Secure, HttpOnly cookies for Admin authentication, so production HTTP will fail.
- Configure an explicit Admin origin and credential support in Strapi CORS. Review the Admin cookie domain and session `sameSite`/`secure` settings for the chosen domains.
- Bake the backend URL into the Admin build and redeploy Admin when its URL, plugins, Admin configuration, or Strapi version changes.
- Set the upload middleware/provider limits and every reverse-proxy body limit consistently. Validate the required maximum file size in a deployment prototype.
- Persist and back up both PostgreSQL and the VPS media directory. A database-only backup is incomplete.

## Primary sources

- [Strapi: Admin panel configuration](https://docs.strapi.io/cms/configurations/admin-panel)
- [Strapi: Server configuration](https://docs.strapi.io/cms/configurations/server)
- [Strapi: Middlewares configuration](https://docs.strapi.io/cms/configurations/middlewares)
- [Strapi: Media Library and upload providers](https://docs.strapi.io/cms/features/media-library)
- [Vercel: Deployments](https://vercel.com/docs/deployments/overview)
- [Vercel: Project configuration](https://vercel.com/docs/project-configuration)

## Decision input

The requested Vercel/VPS split is viable without a custom authoring frontend. The remaining decisions are the exact domains and cookie policy, VPS runtime and persistence layout, upload-size target, backup/restore objective, and coordinated release/rollback contract.
