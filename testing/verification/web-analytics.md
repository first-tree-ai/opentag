# Web App analytics: verification and acceptance

Test and acceptance material for [Web App analytics](../../docs/system/web/web-analytics.md).

## Testing

`AnalyticsReporter` is inert until something arms it, so no suite reports by importing a page. A test that wants events
calls `analytics.arm(sink)` with a recording sink and `analytics.disarm()` afterwards — see
`apps/web/src/__tests__/analytics-funnel.test.tsx`. No module mocking is involved.
