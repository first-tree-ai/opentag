# Migration policy

Migration files are an append-only history of database changes. A migration is historical once it
is committed or applied to any shared database. Do not edit or delete its SQL, change its journal
index or tag, reorder journal entries, or rewrite its generated metadata. These changes can make a
database appear to have a different history and can cause later migrations to run against the
wrong schema. The migration drift check records each file's SHA-256 digest to make this rule
enforceable.

To change an existing design, add a new migration with `pnpm --filter @opentag/server db:generate`
and review the generated SQL. Run `pnpm check:schema-drift` and the migration drift check before
committing. Use the drift check's explicit `--update` option only after confirming that the new
migration is appended and its SQL is complete; never use it to bless an edit to history.

## Rollback notes

If a migration must be rolled back operationally, do not remove or alter the original file. Add a
forward migration when possible and record a rollback note with:

- the migration tag and deployment or database environments affected;
- the observed failure, including relevant timestamps and error identifiers;
- the exact compensating SQL or release change, with a backup and restore plan;
- data-loss, locking, and compatibility risks and the validation query or test used; and
- the owner, approval, execution time, and follow-up migration or remediation plan.

Rollback notes describe an operational event. They do not change the immutable migration history.
