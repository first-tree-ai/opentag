# SQL caller repairs: selected Git subtree verification

Batch 8b closes AG-F6. Verification checks each ancestor entry separately and
recursively lists only the literal selected subtree before checkout. Combining
ancestor and descendant patterns can include unrelated siblings; separate entry
queries avoid that. Git documents [ls-tree path patterns and NUL output](https://git-scm.com/docs/git-ls-tree).
Global --literal-pathspecs retains bracket/space names exactly. Existing path
length, operation signal, process output bound, filesystem ancestor checks and
pinned Context Tree CLI verification remain. Root selection still enumerates
the whole repository. No broader output limit, parallel Git work or cache.

**41 distinct cases pass, 82 passing executions**, all on host and Docker Linux.
Nine new real-Git cases cover 12,000 unrelated long filenames, nested subtrees,
literal bracket/space paths and ancestor/selected/descendant symlinks and Gitlinks.
A valid selected subtree passes beside the large unrelated directory; selecting
the repository root still reaches resource_limit. Unsupported modes fail before
checkout. The existing 29 GitHub connection operation cases retain final SQL
identity, cancellation and publication behavior. No database behavior changes;
no native PostgreSQL rerun is needed for this scoped Git change.

Typecheck, complexity and repository gates pass without relaxed baselines.
Evidence: `.codex/reports/sql-caller-repairs-20261103/batch-20-*`.
Full repository fetch/checkout cost remains governed by the existing process
budget; selected enumeration does not establish a bound on clone storage size.
Independent review follows the exact commit. CI, merge and deployment are not
part of local acceptance.
