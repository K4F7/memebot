# VPS Runtime Conditions and Persistence Constraints

Date: 2026-08-17

Host inspected: `louis` (`45.142.115.128`, Tailscale `Louis.tail7f02ca.ts.net`)

## Question

Before choosing the first Strapi runtime topology, what are the target VPS CPU, memory, OS, disk, Docker / reverse-proxy / PostgreSQL, domain / TLS, backup, and downtime facts, and how do they constrain local media storage, build location, upgrades, and recovery?

## Finding

`louis` can host the first-version Strapi API, PostgreSQL, and local media volume. It cannot host image builds, a GitHub Actions runner, or a second PostgreSQL container. Deployments must be pull-based: GitHub Actions publishes a GHCR image; the VPS recreates the Strapi container through an authenticated HTTPS webhook. SSH remains an operator channel, not the CI trigger.

```text
GitHub Actions (hosted): typecheck / build / push GHCR tag
        |
        | authenticated HTTPS webhook
        v
louis OpenResty: deploy hook -> compose pull && up --no-build
        |
        +-- Strapi API container (prebuilt image)
        +-- existing 1Panel PostgreSQL 18 (new database + user)
        +-- local media bind mount on the root filesystem
        +-- 1Panel OpenResty TLS for the API hostname
```

Vercel continues to host only the prebuilt Strapi Admin. Watchtower stays on the box for 1Panel apps and must not own Strapi.

## Host facts

| Item | Observed value |
| --- | --- |
| OS | Ubuntu 24.04.4 LTS (`6.8.0-60-generic`), KVM guest |
| CPU | 2 vCPU, AMD EPYC 9554 |
| Memory | 7.8 GiB RAM; ~4.8 GiB available at inspection; 4.0 GiB swap with 2.0 GiB already used |
| Disk | One 150 GiB `ext4` root (`/dev/vda2`); 44 GiB used, 99 GiB free |
| Docker | Docker 29.6.2, Compose v5.3.1; 22 containers, 21 running; images ~18.5 GiB |
| Panel / proxy | 1Panel v2.2.5 + OpenResty; `client_max_body_size 50m`; HTTPS on `:80`/`:443` |
| PostgreSQL | `postgres:18.4-alpine` as `1Panel-postgresql-5f3t`; loopback `:5432`; data bind-mounted at `/opt/1panel/apps/postgresql/postgresql/data` |
| Existing DBs | Shared instance already serves other apps (`easyapi_portal_test`, `xbh_new_api`, plus 1Panel defaults). No Strapi database yet. |
| Tailscale | `tailscaled` up; human SSH via host `louis` |
| Watchtower | 1Panel app `1Panel-watchtower-9OUz` is running |
| Koishi | Compose project `memebot` at `/opt/1panel/docker/compose/memebot`; `memebot.sein.moe` → `127.0.0.1:5141` |
| Current `meme.sein.moe` | 1Panel site exists; proxy target is `127.0.0.1:13001` |

Representative 1Panel TLS sites already on this host: `meme.sein.moe`, `memebot.sein.moe`, `koishi.sein.moe`, `sftpgo.sein.moe`, plus other `*.sein.moe` / `*.easyapi.work` vhosts.

## Backup and downtime

- 1Panel backup root is `/opt/1panel/backup` on the **same** root disk (3.9 GiB).
- Recent artifacts are website / container / app upgrade tarballs. The newest dated from 2026-07-22. There is no current off-box backup of PostgreSQL or a media volume.
- SFTPGo is installed (`sftpgo.sein.moe`, data under `/opt/1panel/apps/sftpgo`) but is not an automated Strapi backup target.
- Acceptable downtime was not declared. First-version deploys should assume only the Strapi container is recreated, with PostgreSQL and the media mount left in place. Host reboot and OpenResty restarts are out of band.

## Constraints

- **Do not build on the VPS.** Two vCPUs and an already-used 2 GiB of swap make `yarn build` / image builds and a self-hosted runner unsafe next to Koishi, mail, and the existing APIs.
- **Do not add a second PostgreSQL.** Create a dedicated database and user on the existing 1Panel PostgreSQL 18. Keep it on loopback.
- **Local media lives on the root filesystem.** There is no separate data disk. Budget image layers, PostgreSQL, media, and same-disk 1Panel backups against the remaining ~99 GiB. A database-only backup is incomplete.
- **Same-disk backups are not disaster recovery.** First-version restore can rebuild the container from a GHCR tag and restore PostgreSQL plus the media directory; host loss still loses both. Off-box backup remains an open follow-up, not a first-version blocker.
- **OpenResty already terminates TLS.** Add the Strapi API as another 1Panel site. Raise or match `client_max_body_size` with Strapi upload limits; the current global cap is 50 MiB.
- **SSH is not the deploy trigger.** ADR 0014 used GitHub Actions SSH to activate a GHCR digest; that path is retired for the new Strapi platform. The confirmed contract is: Actions pushes a versioned GHCR image, then an authenticated OpenResty webhook runs `compose pull && up --no-build` and a health check. Rollback is the same webhook with a previous tag. Secrets stay on the VPS.
- **Watchtower must not track Strapi.** It may keep updating labelled 1Panel apps. Strapi needs an explicit tag, health check, and rollback.
- **Reuse the 1Panel compose layout.** Place the Strapi stack under `/opt/1panel/docker/compose/`, the same pattern as `memebot`.
- **`meme.sein.moe` is occupied.** Reusing it for Strapi API is a topology decision for #64, not a free hostname.

## Decision input

The VPS facts support the split already validated in #62: Vercel Admin + VPS API, with local media and PostgreSQL on `louis`. They also lock the first CI/CD trigger for #65: GHCR image + authenticated webhook, not SSH and not Watchtower.

Remaining human decisions are the API hostname, upload-size target versus the 50 MiB proxy cap, whether first-version backup stays on-box, and the exact webhook authentication / health-check / rollback contract.
