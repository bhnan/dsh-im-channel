# Feishu Session Commands Design

## Scope

The Feishu bridge will expose only DSH Session management in this increment:

- `/sessions` lists Sessions from the running DSH Web Host.
- `/session` shows the Session bound to the current Feishu conversation scope.
- `/session <session-id>` binds the current Feishu scope to an existing DSH Session.
- `/new` creates a Session through `session.create` and binds it immediately.
- `/help` documents these commands alongside the bridge's existing local commands.

Model selection, permission commands, questions, and approval cards remain out of scope.

## Architecture

Session commands use the existing `DshControl` service and the official DSH Web Host RPC API. They never inspect or delete Session directories. The durable `SessionBindings` store maps an account plus P2P, group, or thread scope to an exact DSH Session id, allowing Feishu and the browser UI to continue the same conversation.

The bridge creates the DSH API client only when `dshApiUrl` is configured. Existing subprocess-based prompts remain available as a fallback while shared-host mode is disabled. In shared-host mode, normal prompts resolve the current binding and use `DshControl.prompt()`.

## Authorization

`/sessions`, `/session`, `/session <id>`, and shared-host `/new` require the sender's `open_id` to appear in `controlAllowFrom`. The default list is empty and therefore denies every Session control operation. A denied request returns a short message without exposing Session ids or metadata.

## Command behavior

`/sessions` returns a bounded, newest-first list. Each row includes the Session id, running state, and cwd when available. The currently bound Session is marked. Empty results are reported explicitly.

`/session` returns only the current binding. `/session <id>` verifies the target through `session.list` before changing the binding. `/new` calls `session.create`, binds the returned id, and reports it. RPC, authentication, and unavailable-host failures are converted to user-facing command errors while secrets remain absent from logs and replies.

## Testing

Node tests cover parsing, authorization, list rendering, current-binding display, verified switching, Session creation, shared prompt routing, disabled-mode fallback, and configuration precedence. The full test suite and `git diff --check` must pass before the feature is considered complete.
