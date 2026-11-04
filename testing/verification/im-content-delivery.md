# IM content and attachment delivery: verification and acceptance

Test and acceptance material for [IM content and attachment delivery](../../docs/system/messaging/im-content-delivery.md).

## Validation

Regression tests cover attachment-only Local direct/steer and Cloud dispatch, resource-bearing history, structured
mentions, cards/posts, native media keys, duplicate references, resource overflow, UTF-8 boundaries, terminal validation,
and the absence of eager Client downloads. Native proxy tests cover private downloads and execution-scoped handles.
Staging acceptance additionally requires original-file hashes, actual Agent reads/answers, and provider-visible receipts
on the deployed Server/Client/Runner revision; a successful download or completed Turn alone does not prove understanding.

## Feishu column card candidate (IM-B1/W2)

The isolated regression fixture in `packages/server/src/__tests__/feishu-card-content.test.ts` exercises
`createReliableFeishuDispatcher` and `normalizeFeishuMessage` with provider-shaped `interactive` events. Both a v1
`elements` card and a v2 `body.elements` card contain a `column_set.columns` array with two columns and an image.
Before the fix, the visible text becomes `[Unsupported Feishu element: column_set; read the source message]`, and
the resource list is empty. The expected projection is `W2-LEFT-739`, then `W2-RIGHT-852`, then `[Attachment 1]`, with
the image's native `img_key` retained. A separate fixture verifies the existing 16-resource limit inside a column.
The fix extends the existing bounded traversal to `columns`; no network reads or resource downloads are added.

Structure references:

- [Official v1 column card example](https://open.feishu.cn/community/articles/7271149634339487746)
- [Official column set documentation](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/column-set)
- [Official column color example](https://open.feishu.cn/document/feishu-cards/enumerations-for-fields-related-to-color)

Duplicate checks covered open issues and PRs, including #1110, #1242, #1238, #1243 and #1230. Searches for
`repo:first-tree-ai/opentag column_set` in issues and all PRs returned no matches. Existing #826 and #844 cover
general content/resource projection and inline formatting; the fixed baseline still omits this container field.

### Live acceptance pending

Only source-backed fixtures have been verified locally. Native forwarding and the actual inbound card shape still
require coordinator verification; these fixtures are not captured provider traffic. Ordinary human message composition
does not create an interactive card. A dedicated bot must first send one through the native message API.

Start with this v1 card, which needs no uploaded image. Use `msg_type: "interactive"` and serialize the object into
the API's string `content` field:

```json
{
  "elements": [
    {
      "tag": "column_set",
      "columns": [
        {
          "tag": "column",
          "width": "weighted",
          "weight": 1,
          "elements": [{ "tag": "div", "text": { "tag": "plain_text", "content": "W2-LEFT-739" } }]
        },
        {
          "tag": "column",
          "width": "weighted",
          "weight": 1,
          "elements": [{ "tag": "div", "text": { "tag": "plain_text", "content": "W2-RIGHT-852" } }]
        }
      ]
    }
  ]
}
```

1. Send the card from the dedicated test bot to the test user in their DM. As that user, forward the single card
   back to the dedicated bot conversation through the native UI. Do not use multi-message merge-forward.
2. Inspect the accepted inbound type and sanitized shape before asserting a product failure. The provider has
   distinct single-message and merge-forward operations, but the UI's actual event representation must be observed.
   If it delivers `merge_forward`, or flattens columns into already-preserved text, this is not a live reproduction
   of the candidate. Do not claim acceptance or change routing to manufacture one.
3. If the inbound `interactive` content retains `column_set.columns`, compare its canonical text and Agent-visible
   input before/after the candidate. Both canaries must appear once, in column order, without the unsupported label.
   A follow-up DM may ask the Agent to repeat the two values. Inspect input as well as its answer, because native
   readback could otherwise mask an input projection failure.
4. After proving the pure-text path, optionally add an image component to the second column using a real test image
   key and verify its native resource reference and actual Agent read. A failed download is a separate result.
5. Repeat as a single-card forward into a dedicated test topic only if the DM path retained the structure. Verify
   native thread/root references and that the observer does no task work; this fix does not alter those paths.

The developer does not send Feishu messages, control native UI, or change the shared server/daemon/database. Deployment,
database compatibility, live acceptance, and PR authorization remain with the coordinator.

### Local validation

- `pnpm install --frozen-lockfile`: passed; initialized only this worktree's dependencies and standard Git hooks.
- `pnpm exec turbo run build --filter='@opentag/server^...'`: passed; prepared shared and preset public exports.
- Before the product change, `pnpm --filter @opentag/server test src/__tests__/feishu-card-content.test.ts`:
  all three fixtures failed, exposing the missing text and empty resource list.
- After the change, `pnpm --filter @opentag/server test src/__tests__/feishu-card-content.test.ts
  src/__tests__/native-im-content.test.ts src/__tests__/feishu-adapter.test.ts`: passed, 85 tests in three files.
- `pnpm --filter @opentag/server typecheck`: passed.

This scope covers the changed card projection, native rich-text/resource behavior, and the raw Feishu admission and
normalization path. No persistence, exported contracts, packaging, Client, or Runtime implementation changes are made;
the full suite, PostgreSQL integration, server build, and Agent Runtime coverage are not required for this change.
CI and real IM acceptance remain unverified.
