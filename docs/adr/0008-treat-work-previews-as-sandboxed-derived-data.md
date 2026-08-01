# Treat work previews as sandboxed derived data

Work packages are extracted into a confined local preview area so the archive WebUI can browse their contents, but the ZIP remains the only authoritative attachment. Extraction rejects traversal, absolute paths, symlinks, encrypted archives, excessive entry counts, and excessive expanded size; previews render only allowlisted content under browser sandboxing, are never executed by the server, are not backed up to R2, and can always be regenerated from the package.
