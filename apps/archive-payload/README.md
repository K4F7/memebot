# MemeBot Archive Payload application

This is an independent PayloadCMS application for the Archive Work/media MVP. It is not a
root Yarn workspace. Use the Yarn version declared in `package.json` from this directory:

```sh
yarn install
yarn payload migrate
yarn dev
```

Production uses the official Next.js/OpenNext Cloudflare shape. `wrangler.jsonc` declares the
private `R2` bucket and the `D1` metadata binding. Set `PAYLOAD_SECRET`,
`ARCHIVE_SERVICE_TOKEN`, and `ARCHIVE_MEDIA_SIGNING_SECRET` as Worker secrets before deploying.
`yarn build` runs the Next production build; `yarn deploy` applies D1 migrations and deploys the
OpenNext worker.

The OpenNext Worker bundle requires a Cloudflare Workers Paid plan. The Free plan's 3 MiB Worker
script limit is smaller than the Payload Admin/runtime bundle, even with Wrangler minification.

The authenticated `/admin` panel is the only write surface. The collections are:

- `works`: title, author, optional description, and server-assigned stable `W<n>` identifier;
- `media`: R2-backed image/PDF bytes and required Work ownership;
- `work-media`: one-to-one Media ownership, display order, and optional caption.

The machine-authenticated read contract is:

```text
GET /api/archive/v1/works?query=<text>&author=<author>
GET /api/archive/v1/works/<Wn>
GET /api/archive/v1/media/<media-id>?expires=<unix>&signature=<short-lived-signature>
Authorization: Bearer <ARCHIVE_SERVICE_TOKEN>
```

Only completed WorkMedia relationships are returned. Media URLs are signed for a short period
and are served from the private R2 binding; the R2 bucket is never made public.

Cloudflare Workers does not provide native Sharp. The app disables Payload image transforms and
pins Next's optional `sharp` dependency to the checked-in Worker stub, so OpenNext never bundles a
native `.node` module. Image/PDF bytes still upload directly to R2 and are served unchanged.
