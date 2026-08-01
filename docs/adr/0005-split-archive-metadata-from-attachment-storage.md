# Split archive metadata from attachment storage

The archive plugin stores searchable metadata, stable identifiers, lifecycle state, and backup status through Koishi's database service, while attachment bytes remain in the configured local directory as the primary copy. R2 holds secondary attachment copies plus an archive-specific metadata manifest that can rebuild archive tables without coupling the plugin to backup details of the deployment's complete Koishi database.
