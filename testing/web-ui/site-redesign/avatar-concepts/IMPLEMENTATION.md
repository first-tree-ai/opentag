# Avatar replacement validation

The approved avatar update supersedes the earlier instruction to retain the old
cats. All six PNGs and all six SVGs are replaced in `apps/web/public/bot-avatars/v1/`
without changing their paths, names, preset IDs, or registration ordering.

| Filename stem | Replacement |
| --- | --- |
| `developer` | Website Engineering |
| `engineer` | Website General |
| `artist` | Website Design |
| `sales` | Website Growth |
| `architect` | Approved Product concept |
| `businessman` | Approved Operations concept |

The website artwork comes from `opentag-site` commit
`4f63d20383045861ca5cd93be8196829f0974e5f`, using the circular Lark variants.
Their source paths remain intact and accessibility titles are added. The two
generated images are resized to the existing 512 × 512 PNG contract, with alpha
preserved. Their SVGs embed the exact production PNG bytes; no approximation or
automatic tracing alters the approved illustration.

## Evidence

- [Complete set, including 32px PNG and 40px SVG samples](avatar-set.png).
- [Soul presets in the built application](soul-presets.png).
- The browser loaded every PNG and SVG in the gallery successfully.
- Website SVGs rendered to 512px match their PNG exports pixel for pixel.
- The generated SVGs embed their matching PNG bytes.
- Both server static-serving and Feishu registration test files passed: 7 tests.
  Coverage verifies all six legacy PNG paths, 512px dimensions, CORS, all six SVG
  paths, and unchanged registration URLs/order.
- Production web build passed; `pnpm check` and `git diff --check` passed.

## Cache and provider behavior

Stable avatar URLs now return `public, max-age=0, must-revalidate`. Hashed build
assets retain immutable caching. Responses already stored under the previous
one-year immutable policy may still need cache eviction or a hard refresh after
deployment; a new response header cannot revoke an old cached response.

Feishu copies the selected image when registering a Bot. Replacing this asset set
updates the app's preset artwork and future registration choices; it does not
edit already-uploaded provider avatars or custom images. No deployment or provider
profile update was performed.
