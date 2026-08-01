# Retain removed archive items for recovery

Removing an archive item hides it from normal searches but retains its metadata, local attachment, and R2 backup for 30 days. Administrators can restore it or purge it early from the WebUI; expiry permanently removes all copies, with failed remote cleanup remaining retryable rather than blocking local cleanup. The retention period is fixed rather than exposed as configuration.
