# pipeline-plugin

- When code moves a ticket back to an earlier status, reset in the same statement every column that only the
  later status sets (for example `owner` and `owner_seen` on `in_progress`).
