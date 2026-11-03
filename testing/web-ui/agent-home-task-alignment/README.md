# Agent home task table alignment

Supports the [Web UI contract](../../../docs/system/web/web-ui-contract.md).

The compact task table on the Agent home sat 12px inside its card title, because the table cells keep their own
inset. The compact table region now pulls out by that inset (`-mx-3`), so the title, column headers, and cell text
share one left edge, and the right edge lines up with View all. Row hover keeps its padding. The full `/tasks` table
is unchanged.

Measured in a local sandbox (synthetic team data, zh), as the left edge in pixels of title / column header / cell text:

| Width | Before | After |
| --- | --- | --- |
| 1440 | 337 / 349 / 349 | 337 / 337 / 337 |
| 768 | 249 / 260 / 261 | 249 / 248 / 249 |
| 390 | 37 / 48 / 49 | 37 / 36 / 37 |
| 320 | 37 / 48 / 49 | 37 / 36 / 37 |

The remaining 1px is text-measurement rounding. There is no horizontal overflow at 320 or 1440px.

- [1440px before](1440-before.png) and [after](1440-after.png)
- [768px after](768-after.png)
- [390px before](390-before.png) and [after](390-after.png)
- [320px after](320-after.png)
