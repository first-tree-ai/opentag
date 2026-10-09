---
name: gcloud-service-logs
description: Read and debug logs from deployed services with the gcloud CLI. Use whenever someone asks to check, search, tail, or explain production, staging, or other online logs, debug a deployed service that is throwing errors, or find log evidence for an incident; triggers on gcloud, Google Cloud Logging, Cloud Run, GCE compute instances, GKE, CapRover, Docker Swarm, and phrases like 查看线上日志, 查线上服务日志, 抓一下日志, 线上报错了. Covers Cloud Logging queries, host and container log reads over gcloud compute ssh when a service does not ship logs, and safe setup guidance that keeps the gcloud login on the operator's own machine.
---

# gcloud service logs

Reach the log lines behind a deployed service using only the operator's own gcloud login. Two read
paths, tried in order — Cloud Logging first, because it needs no SSH and survives a host outage:

1. **Cloud Logging** — `gcloud logging read`. Works for Cloud Run, GKE, and anything whose log
   driver ships records to Google Cloud.
2. **Host logs** — `gcloud compute ssh` plus `docker` or `systemd` on the machine that runs the
   service. This is the path for self-hosted deployments (CapRover or plain Docker Swarm on a
   Compute Engine VM) whose container logs never reach Cloud Logging.

An empty Cloud Logging result is not evidence of health. A container's stdout only appears in Cloud
Logging when the Docker daemon's log driver is configured for it; on a minimal self-hosted host it
usually is not. The two paths also retain different history: host logs rotate away when a service is
redeployed, while Cloud Logging keeps whatever was shipped. Treat them as complementary, and say
which one produced each piece of evidence.

## Ground rules

- **Keep the Skill free of operator identifiers.** Never put an account, project id, or environment
  host into this Skill's text, its examples, or any committed file; discover them at run time from
  the active gcloud configuration and use placeholders (`<PROJECT_ID>`, `<INSTANCE>`, `<ZONE>`,
  `<SERVICE>`, `<CONTAINER>`) here. A Skill that carries one team's identifiers breaks for everyone
  else and leaks those identifiers wherever it is installed. A runtime report is different: include
  the real project and host where reproducibility needs them, and keep credentials and personal data
  out. When a value is missing, ask; do not guess and do not reuse another environment's.
- **The login belongs to the operator.** `gcloud auth login` and `gcloud auth application-default
  login` open a browser and block. Never run them on someone's behalf; detect the missing login,
  hand over the exact commands, and wait for the operator to confirm.
- **Read-only by default, with one setup side effect to respect.** `logging read`, `list`, and
  `describe` never change anything. `gcloud compute ssh` is only a pure read once SSH access already
  exists: with no usable key it can generate a key pair, save the private key locally (with an empty
  passphrase when `--quiet` suppresses the prompt), and register the public key in project or
  instance metadata. That provisioning is a configuration change, and it cannot be ruled out by
  inspecting local files or metadata from the outside: require the operator to complete and confirm
  a first connection to the target before any unattended read (Step 3). Restarting, scaling,
  deploying, and editing configuration remain separate requests; ask first.
- **Do not leak what logs leak.** Log lines can carry access tokens, email addresses, and customer
  data. Quote only the lines that answer the question, redact secrets, and never copy a whole log
  stream into a report or a chat message.
- **gcloud prompts block agents.** Pass `--quiet` and `--format=...`, and wrap remote calls in
  `timeout`, so a missing permission or an SSH prompt fails quickly instead of hanging.

## Step 0 — Preflight, always

```sh
command -v gcloud >/dev/null && gcloud version
gcloud auth list --filter=status:ACTIVE --format='value(account)'
gcloud config get-value project
```

| Result | What to do |
| --- | --- |
| `gcloud` missing | point the operator at the install guide (https://cloud.google.com/sdk/docs/install) and stop |
| no active account | hand over `gcloud auth login` and wait for the operator before any log call |
| no project configured | ask which project serves the environment, or hand over `gcloud config set project <PROJECT_ID>` |
| account and project present | carry `--project=<PROJECT_ID>` on every later call — every example in Steps 1–4 includes it — because an omitted flag falls back to the mutable `core/project` setting and a configuration switch mid-session would silently retarget the search |

If the operator keeps several configurations, `gcloud config configurations list` shows them and
`gcloud config configurations activate <NAME>` selects one — confirm the active configuration before
drawing conclusions from its project.

## Step 1 — Locate what serves the environment

Match the operator's words — a domain, an environment name like staging, an application error — to a
runtime. When two candidates could serve the same domain, ask instead of picking.

| Runtime | Discovery command |
| --- | --- |
| Cloud Run | `gcloud run services list --project=<PROJECT_ID> --platform=managed --format='value(metadata.name,metadata.region,status.url)'` |
| Compute Engine VM | `gcloud compute instances list --project=<PROJECT_ID> --format='value(name,id,zone,status,networkInterfaces[0].accessConfigs[0].natIP)'` |
| GKE | `gcloud container clusters list --project=<PROJECT_ID> --format='value(name,location,status)'` |
| App Engine | `gcloud app describe --project=<PROJECT_ID> --format='value(id,defaultHostname)'` |

The instance name often carries the environment. Describe a candidate before assuming it is the
target, and record its numeric ID — Cloud Logging's standard `gce_instance` entries are keyed by
`resource.labels.instance_id`, not by name:

```sh
gcloud compute instances describe <INSTANCE> --project=<PROJECT_ID> --zone=<ZONE> \
  --format='value(status,machineType,id,tags.items)'
```

## Step 2 — Cloud Logging first

```sh
gcloud logging read '<FILTER>' \
  --project=<PROJECT_ID> --freshness=1d --limit=50 \
  --format='value(timestamp,severity,resource.type,resource.labels.service_name,jsonPayload.msg,textPayload)'
```

- `--freshness` accepts short durations such as `30m`, `1h`, `1d`. Start with the narrowest window
  the operator gave and widen only when it comes back empty. `--limit` bounds the payload. Results
  are newest-first by default, which is what "what is happening now" needs.
- For a chronological timeline, do **not** combine `--freshness` with `--order=asc`: on gcloud 588
  that combination was observed to silently return entries outside the window (a `--freshness=5m`
  read returned month-old entries). Filter with an explicit `timestamp>="<RFC3339>"` and then pass
  `--order=asc`.
- Build the filter from facts, not guesses. Common shapes:

  | Goal | Filter fragment |
  | --- | --- |
  | one Cloud Run service | `resource.type="cloud_run_revision" AND resource.labels.service_name="<SERVICE>"` |
  | one Compute Engine VM | `resource.type="gce_instance" AND resource.labels.instance_id="<NUMERIC_INSTANCE_ID>"` (the standard resource carries `project_id`, `instance_id`, and `zone` — never `instance_name`) |
  | container logs collected by the Ops Agent | `logName:"docker_containers"` (the exact log name depends on the driver and agent) |
  | a Swarm service in those entries | `jsonPayload.attrs."com.docker.swarm.service.name"="<SERVICE>"` |
  | a VM whose entries carry an Ops-Agent host label | `labels."compute.googleapis.com/resource_name":"<INSTANCE>"` (substring match; confirm from a sample entry first) |
  | errors and worse only | `severity>=ERROR` (see the note below for container logs) |
  | a structured message field | `jsonPayload.msg="..."` |
  | an application error code | `jsonPayload.errorCode="<CODE>"` |
  | one request across services | `jsonPayload.requestId="<ID>"` |
  | free text in a plain payload | `textPayload:"<substring>"` |

- Container logs collected by the Ops Agent or a Docker log driver commonly carry no `severity` and
  keep the application line as a string in `jsonPayload.log`. `severity>=ERROR` then matches nothing,
  and a `jsonPayload.msg=...` filter matches nothing either: search the payload text
  (`jsonPayload.log:"<substring>"`, `textPayload:"<substring>"`) and parse the level yourself — in a
  pino line, `"level":50` is an error, which the filter spells `jsonPayload.log:"\"level\":50"`. On
  an Ops-Agent host `severity>=ERROR` can still match syslog noise (sshd, kernel) while missing every
  container error, so keep the two streams apart. An empty result from the wrong field is not
  evidence of health.
- `gcloud logging logs list --project=<PROJECT_ID>` names the log streams the project actually has,
  but print it with `--format=json`: a `--format='value(name)'` read prints blank lines because the
  response is a flat array, and an empty list is inconclusive rather than proof that no stream exists.
- Before trusting a label filter, dump one entry with the coarse filter and `--limit=1 --format=json`
  to see which labels and payload fields exist and what they hold: the standard `gce_instance`
  resource never has `instance_name`, and labels such as `compute.googleapis.com/resource_name` are
  Ops-Agent additions that not every GCE log carries. Label values are often more than the bare
  name — a `resource_name` value may be the full internal host name — so match those as substrings
  rather than exact equalities.
- Prefer the narrowest query that answers the question: a tight filter with `--format='value(...)'`
  and a small `--limit`. Widen, or move to Step 3, only when it is genuinely empty; re-reading whole
  streams burns context without adding evidence.
- An empty result means "no matching entries in this window", not "no incidents". Report the window
  and filter — then continue to Step 3 **only when Step 1 identified a self-hosted Compute Engine
  deployment**. Managed runtimes have no host to SSH into: a Cloud Run, GKE, or App Engine service
  stays on its own resource-specific filter. Never fall back to enumerating unrelated VMs because a
  managed query came back empty.
  `PERMISSION_DENIED` is different: name the missing role (`roles/logging.viewer`) instead of
  retrying as if the result were empty.

## Step 3 — Read logs on the host (self-hosted fallback)

This Step applies only to a Compute Engine VM that Step 1 identified as the self-hosted host of the
service. Cloud Run, GKE, and App Engine have no self-hosted host and stay on their own log streams
in Step 2; direct pod logs would need an explicitly context-pinned `kubectl` workflow, which is out
of scope here.

### Gate unattended SSH on a confirmed first connection

`gcloud compute ssh` provisions access when none exists: it can create a key pair, save the private
key locally (with an empty passphrase when `--quiet` swallows the prompt), and register the public
key in project or instance metadata (or the OS Login profile). Whether the next unattended call will
provision cannot be proven from the outside — a local key file does not say whether the target
accepts it, OS Login ignores metadata keys, project keys can be blocked per instance, and a metadata
entry for someone else's key says nothing about the current one.

So do not try to verify access yourself. Before the first `--quiet` read, require the operator to
connect to this exact target once and confirm it:

```sh
gcloud compute ssh <INSTANCE> --project=<PROJECT_ID> --zone=<ZONE>
```

This one interactive command is their setup step; it may create and register a key, and only the
operator sees what it did. After they confirm a successful connection, the `--quiet` reads below
reuse that provisioned access and change nothing. If no connection to this target has been confirmed,
stop and hand the command over instead of running the reads.

"External IP address was not found; defaulting to using IAP tunneling" is normal on a private VM;
SSH then also needs `roles/iap.tunnelResourceAccessor`, not just Compute access.

- Find the service from the confirmed host, then read its logs:

  | Deployment | Service listing | Log command |
  | --- | --- | --- |
  | Docker Swarm / CapRover | `sudo docker service ls` | `sudo docker service logs --since <window> --timestamps <SERVICE>` |
  | plain Docker | `sudo docker ps` | `sudo docker logs --since <window> --timestamps <CONTAINER>` |

  ```sh
  timeout 90 gcloud compute ssh <INSTANCE> --project=<PROJECT_ID> --zone=<ZONE> --quiet \
    --command='sudo docker service logs --since 6h --timestamps <SERVICE> 2>&1 | tail -n 200'
  ```

- CapRover-managed apps often appear as `srv-captain--<app>` and its own components as `captain-*`,
  but the actual names depend on how the app was created — read the `docker service ls` output
  instead of assuming a prefix. On Swarm, `docker service logs` merges every replica, so the task id
  on each line is what tells replicas apart; `--timestamps` is what lets you correlate them.
- Host logs belong to the current task and rotate away on redeploy. When the incident predates the
  last deployment, check Cloud Logging first even for a self-hosted host; when Cloud Logging has no
  entries for the host, the host path is the only source left.
- Filter remotely instead of downloading everything: pipe to
  `grep -i -E 'error|fail|exception|<CODE>'` and keep `tail` last so the newest matching lines are
  the ones that survive. One JSON log line can be kilobytes long — never dump a full stream.
- `docker` needs `sudo` on most hosts, and a non-interactive command cannot answer a password
  prompt; if it asks, the operator has to grant access differently.

## Step 4 — Correlate the deployed revision when it matters

A log line explains behavior; the image tag explains which code produced it. When a fix is expected
to be live, verify what is actually running before drawing conclusions:

```sh
timeout 60 gcloud compute ssh <INSTANCE> --project=<PROJECT_ID> --zone=<ZONE> --quiet \
  --command='sudo docker service ls --format "{{.Name}} {{.Image}}"'
```

Compare the image tag against the commit that carried the fix. Do not assume "deployed" means the
revision with the change; the log evidence and the image tag together are the proof.

## Step 5 — Report

State, in the operator's language:

- the environment, the log source (Cloud Logging stream, or host plus service), and the exact time
  window searched;
- the commands actually run, with the real values substituted, so the operator can reproduce them;
- the relevant lines, trimmed to the fields that matter and redacted;
- when nothing matched: the window and filter that produced nothing, and whether both read paths
  were exercised.

Never present a result from the wrong environment, a stale window, or a guessed project as current.

## When the operator has not configured gcloud yet

Hand over this sequence; each step is theirs to run:

1. Install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install) and confirm
   `gcloud version` answers.
2. `gcloud auth login` — opens the browser and stores credentials locally. On a machine without a
   browser, `gcloud auth login --no-launch-browser` prints a URL to open elsewhere, and recent gcloud
   versions also offer a `--no-browser` remote-bootstrap flow. Nothing should be pasted into a chat,
   a repository, or a shared file.
3. `gcloud config set project <PROJECT_ID>` — select the project that owns the target environment,
   or pass `--project=<PROJECT_ID>` per command.
4. Verify with `gcloud auth list --filter=status:ACTIVE --format='value(account)'` and
   `gcloud config get-value project`.
5. Ask the environment owner for read access when a command is denied: `roles/logging.viewer` for
   Cloud Logging, and `roles/iap.tunnelResourceAccessor` when SSH goes through IAP.

Keep several environments apart with named configurations (`gcloud config configurations create`,
`gcloud config configurations activate`) instead of editing one default back and forth.
