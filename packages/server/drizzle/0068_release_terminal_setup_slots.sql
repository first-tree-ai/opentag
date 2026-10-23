-- A first-time Feishu setup inserts its im_bindings row as `provisioning` before anything is
-- authorized, and `im_bindings_agent_current_unique` ("agent_id" WHERE "status" <> 'disabled')
-- makes that row the Agent's only slot. Settling such an attempt used to mark the setup state
-- terminal and keep the row, so an Agent that never completed an authorization kept holding the
-- slot: the Slack configuration reads take the raw row and refuse the other Provider with
-- IM_BINDING_UNBIND_REQUIRED, and a Slack insert collides on the same unique index.
--
-- The runtime now disables the row in the transaction that settles its attempt. This backfill
-- applies the same release to the rows the previous binaries left behind.
--
-- The fence is the release's own guard: a row that activated has "activated_at", so an active
-- connection and a working connection whose reauthorization attempt was canceled are left
-- untouched. "credential_generation" stays as it is: nothing was ever issued for these rows, so
-- there is no grant or delivery to fence.
UPDATE "im_bindings"
SET "status" = 'disabled',
    "disabled_at" = now(),
    "setup_owner_instance_id" = NULL,
    "setup_owner_heartbeat_at" = NULL,
    "encrypted_setup_context" = NULL,
    "setup_expires_at" = NULL,
    "connection_owner_instance_id" = NULL,
    "connection_lease_expires_at" = NULL,
    "updated_at" = now()
WHERE "status" = 'provisioning'
  AND "setup_state" IN ('canceled', 'expired', 'failed')
  AND "activated_at" IS NULL
  AND "encrypted_credential" IS NULL;
