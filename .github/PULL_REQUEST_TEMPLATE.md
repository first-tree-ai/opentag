## Summary

<!-- What changed, and why? -->

## Testing

<!-- List the commands and manual checks you ran, why that scope covers the change, and anything not run or blocked.
     Follow DEVELOPMENT.md#local-validation; the complete CI matrix must pass before merge. -->

## UI validation

<!-- Complete this section only when the pull request changes rendered UI. Remove it otherwise. -->

- Desktop evidence:
- Mobile evidence:
- Widths checked (`320px` / `390px` / `768px` / `1440px`; explain any N/A):
- States verified:
- Keyboard/accessibility checks:
- New reusable block, theme value, or CSS exception:

## Breaking changes

<!-- Describe compatibility impact, or write "None". -->

## Checklist

- [ ] The change is focused and contains no unrelated work.
- [ ] Tests and documentation cover the changed behavior.
- [ ] `pnpm check` and the applicable local checks in `DEVELOPMENT.md#local-validation` pass; omissions are explained above.
- [ ] No credentials, private data, or generated build output are included.
- [ ] Canonical English docs and Chinese mirrors are synchronized when applicable.
