# IM task recovery browser verification

The production `ImFeedbackPage` component was rendered from an isolated Vite production bundle with the
application stylesheet, theme and fonts. All feedback reads used a synthetic fixture; the harness blocked
mutation requests. This is component browser verification, not authenticated whole-app or native IM acceptance.

English and Simplified Chinese each passed at 320, 390 and 1440 pixels:

- No horizontal overflow in the overview or discard review.
- Choosing discard requires a separate loss acknowledgement; opening the page does not submit it.
- Space toggles the checkbox and Tab reaches the final confirmation button.
- No browser exceptions or axe violations in the rendered page, with its normal main landmark.

The behavioral tests additionally verify fresh-read failures, generation changes, unknown POST results,
unverified releases, Chinese warnings, and the collapsed owner notice list. No Cloud resource, archive,
external task or real IM message was changed.

See [machine-readable results](browser-check.json), [English desktop](en-1440.png),
[Chinese phone overview](zh-390.png), and [Chinese minimum-width discard review](zh-320-discard.png).
