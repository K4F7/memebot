---
status: accepted
---
# Operate Payload through the existing VPS boundary

Payload runs on `louis` behind the 1Panel-managed HTTPS reverse proxy for `meme.sein.moe`; 1Panel forwards to `127.0.0.1:13000`, while the container continues to listen on port `3000`. The repository owns only the loopback-bound application container and does not manage Nginx or 1Panel configuration. PostgreSQL is the existing VPS service, with a dedicated Archive database and user but no new database container. Production releases are promoted from `main` through the protected GitHub `production` Environment: Actions publishes an image digest and SSH activates it, while the VPS retains the application `.env` and all runtime secrets. Before approving a release that contains a schema migration, the operator takes the required PostgreSQL dump; Payload applies the migration during startup after approval. Image rollback never downgrades the database, so the previous image must remain compatible with the migrated schema. Automated backup, restore, and disaster-recovery guarantees are explicitly deferred.
