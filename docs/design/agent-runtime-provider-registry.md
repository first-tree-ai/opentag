# Agent Runtime Provider Registry

Status: normative Client composition design

Last updated: 2026-08-20

## Purpose

The Provider Registry is the only production Client module that associates a
Provider ID with runtime construction and local trust decisions. Higher runtime
modules consume the registry and do not branch on Codex, Claude Code, or Pi.

Provider IDs use the stable `[a-z][a-z0-9-]{0,63}` form so they remain safe
persistence and lookup keys.

Each registration owns exactly four concerns:

- the `AgentRuntimeFactory` that creates and resumes the Provider Runtime;
- the opaque artifact identity persisted with Session bindings;
- readiness probing plus optional artifact verification;
- Provider-specific policy validation and common `AgentRuntimePolicy` mapping.

Readiness is keyed and deduplicated per Provider. A failed refresh revokes that
Provider only. Concurrent waiters share the underlying probe but retain their
own cancellation signal.

## Module Boundaries

```text
Client Runtime composition
  -> AgentRuntimeProviderRegistry
       -> Provider registration
            - factory
            - artifact identity
            - readiness/artifact verification
            - policy validation/mapping
  -> SessionRuntimeManager
       -> registry.registration(snapshot.provider)
  -> SessionBindingStore
       -> registry.artifactIdentity(binding.provider)
```

`SessionRuntimeManager` no longer owns a factory map, a global availability
boolean, or a Codex policy function. `SessionBindingStore` resolves artifact
identity by Provider ID instead of comparing every binding with one global Home
identity. Workspace and reconciler state persist a bounded Provider string and
fence identity changes without hard-coding one Provider.

The persisted v1/v2 field name `providerHomeIdentity` is retained for backward
compatibility. Its value is now defined as a Provider artifact identity; no
schema migration or local path disclosure is introduced.

## Current Production Registration

Production composition registers Codex only. This PR does not widen the Shared
effective-snapshot schema or the Server assembler, so Claude Code and Pi remain
standalone contract implementations and live-smoke targets.

A future Provider production PR must add one reviewed registration and update
the entire upstream chain in the same security review:

1. Shared Provider schema and effective runtime snapshot;
2. Server authority and snapshot assembly;
3. local artifact identity definition and verification;
4. readiness semantics and credential boundary;
5. enforceable policy validation and common policy mapping;
6. Session binding, restart/resume, custody, and live end-to-end tests.

Registering a factory alone is deliberately insufficient.
