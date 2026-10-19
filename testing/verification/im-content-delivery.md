# IM content and attachment delivery: verification and acceptance

Test and acceptance material for [IM content and attachment delivery](../../docs/system/messaging/im-content-delivery.md).

## Validation

Regression tests cover attachment-only Local direct/steer and Cloud dispatch, resource-bearing history, structured
mentions, cards/posts, native media keys, duplicate references, resource overflow, UTF-8 boundaries, terminal validation,
and the absence of eager Client downloads. Native proxy tests cover private downloads and execution-scoped handles.
Staging acceptance additionally requires original-file hashes, actual Agent reads/answers, and provider-visible receipts
on the deployed Server/Client/Runner revision; a successful download or completed Turn alone does not prove understanding.
