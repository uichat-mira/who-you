# Gmail operation ownership (OPS-044)

Gmail sync, unlink and authorization persistence share an exclusive D1 owner on the existing mailbox sync row. Acquisition requires a still-linked mailbox owned by the caller. The lease expiry timestamp is **diagnostic only**: it is not safe to infer that a Worker invocation or R2 write has stopped merely because five minutes have elapsed. No automatic takeover. Normal completed/failed calls release their exact owner after awaited operations settle. A terminated invocation may leave an outstanding owner, and the UI reports recovery required rather than falsely claiming success or allowing a new writer.

Unlink records a durable pending intent before destructive work. Even after a recoverable error releases ownership, sync and reauthorization cannot proceed until unlink finishes. Unlink deletes the mailbox's R2 namespace (including unindexed objects) and existing indexed keys before removing D1 rows; a storage failure is not success.

## Recovery boundary

An outstanding owner past the diagnostic deadline is an operational incident. Do not clear it based on age, a quiet log, or an absent client connection. An operator must first establish that the owning invocation and its outstanding storage operations have terminated, quiesce relevant entrypoints if necessary, and identify the exact mailbox/owner. If this cannot be proven, keep it blocked. Any exceptional recovery mutation needs separate authorization and an exact owner comparison; no automatic cleanup or manual recovery endpoint is introduced by OPS-044. If unlink was pending, retry the confirmed unlink, not sync or reauthorization. Real mailbox operations and production deployment require separate approval.
