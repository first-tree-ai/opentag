# Offline synthetic orchestration results

These timings measure a local fixture with stub Pi/MCP/model/IM, not OpenTag Cloud or user-perceived latency.
Successful-attempt quantiles use nearest rank. P90/P95 require 100 successes; P99 requires 1,000.
All attempts remain in the denominators. Stage durations must not be summed into endpoint percentiles.
Environment: linux/arm64, Node v24.21.0; CPU quota 100000 100000; memory limit 1073741824.
Workload SHA-256: `d439ac1bc05bd7fdec0e95624d446657e35c155a6bbb6e384e67b28b9c2ebeaa`. Image: `sha256:90d5c0acdc0ffdc596d3b30c4d3faf0ad201eae6ba26b695bb8644053aef7c16`.

| Scenario | Attempts | Success | Failed | Timeout | Incomplete | Timeout rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cold-empty | 100 | 100 | 0 | 0 | 0 | 0.00% |
| warm-64k | 100 | 100 | 0 | 0 | 0 | 0.00% |
| restored-4m | 100 | 100 | 0 | 0 | 0 | 0.00% |
| mcp-64k | 100 | 100 | 0 | 0 | 0 | 0.00% |
| injected-rejection | 1 | 0 | 1 | 0 | 0 | 0.00% |
| injected-timeout | 1 | 0 | 0 | 1 | 0 | 100.00% |

## cold-empty

Milliseconds; stage rows aggregate repeated calls within each successful attempt.

| Metric | n | Missing | P50 | P90 | P95 | P99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ingress_to_first_receipt | 100 | 0 | 18.73 | 22.78 | 23.87 | — | 35.24 |
| ingress_to_terminal | 100 | 0 | 20.39 | 25.13 | 27.56 | — | 41.04 |
| ingress_to_checkpoint | 100 | 0 | 22.62 | 28.89 | 35.59 | — | 46.40 |
| ingress_to_report_ack | 100 | 0 | 22.63 | 28.90 | 35.59 | — | 46.40 |
| ingress_queue | 100 | 0 | 3.11 | 4.25 | 4.39 | — | 4.54 |
| runtime_assembly | 100 | 0 | 0.02 | 0.03 | 0.04 | — | 0.11 |
| sandbox_provision | 100 | 0 | 0.10 | 0.22 | 0.31 | — | 1.99 |
| workspace_restore | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.06 |
| pi_startup | 100 | 0 | 14.59 | 18.49 | 20.35 | — | 29.87 |
| mcp_startup | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.04 |
| model_ttft | 100 | 0 | 0.06 | 0.14 | 0.23 | — | 0.96 |
| tool_call | 100 | 0 | 0.29 | 0.51 | 0.62 | — | 4.41 |
| im_outbound | 100 | 0 | 0.28 | 0.72 | 1.13 | — | 2.08 |
| terminal_cleanup | 100 | 0 | 1.37 | 2.64 | 3.24 | — | 5.45 |
| checkpoint | 100 | 0 | 1.80 | 4.75 | 6.75 | — | 18.21 |
| report_ack | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.03 |

Resource profiles include failed attempts when the counter was observed. CPU is milliseconds; I/O is logical fixture bytes, not physical disk I/O.

| Resource | n | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: |
| parentCpuMs | 100 | 2.68 | 4.67 | 8.53 |
| workerCpuMs | 100 | 14.94 | 18.81 | 21.14 |
| logicalReadBytes | 100 | 62.00 | 62.00 | 62.00 |
| logicalWriteBytes | 100 | 62.00 | 62.00 | 62.00 |

## warm-64k

Milliseconds; stage rows aggregate repeated calls within each successful attempt.

| Metric | n | Missing | P50 | P90 | P95 | P99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ingress_to_first_receipt | 100 | 0 | 18.02 | 21.22 | 23.41 | — | 34.31 |
| ingress_to_terminal | 100 | 0 | 19.55 | 23.89 | 26.69 | — | 36.05 |
| ingress_to_checkpoint | 100 | 0 | 22.22 | 27.27 | 32.30 | — | 42.07 |
| ingress_to_report_ack | 100 | 0 | 22.23 | 27.27 | 32.31 | — | 42.08 |
| ingress_queue | 100 | 0 | 3.28 | 4.20 | 4.33 | — | 4.54 |
| runtime_assembly | 100 | 0 | 0.02 | 0.03 | 0.03 | — | 0.11 |
| sandbox_provision | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.00 |
| workspace_restore | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.00 |
| pi_startup | 100 | 0 | 14.25 | 17.55 | 19.75 | — | 31.36 |
| mcp_startup | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.00 |
| model_ttft | 100 | 0 | 0.06 | 0.13 | 0.18 | — | 0.36 |
| tool_call | 100 | 0 | 0.27 | 0.40 | 0.48 | — | 0.78 |
| im_outbound | 100 | 0 | 0.28 | 0.46 | 1.01 | — | 2.16 |
| terminal_cleanup | 100 | 0 | 1.30 | 2.02 | 3.20 | — | 6.02 |
| checkpoint | 100 | 0 | 2.19 | 3.97 | 5.46 | — | 12.31 |
| report_ack | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.00 |

Resource profiles include failed attempts when the counter was observed. CPU is milliseconds; I/O is logical fixture bytes, not physical disk I/O.

| Resource | n | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: |
| parentCpuMs | 100 | 2.83 | 4.65 | 7.64 |
| workerCpuMs | 100 | 14.23 | 18.05 | 23.07 |
| logicalReadBytes | 100 | 66322.00 | 66324.00 | 66324.00 |
| logicalWriteBytes | 100 | 786.00 | 788.00 | 788.00 |

## restored-4m

Milliseconds; stage rows aggregate repeated calls within each successful attempt.

| Metric | n | Missing | P50 | P90 | P95 | P99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ingress_to_first_receipt | 100 | 0 | 34.29 | 48.98 | 56.08 | — | 80.45 |
| ingress_to_terminal | 100 | 0 | 36.22 | 52.26 | 59.65 | — | 83.35 |
| ingress_to_checkpoint | 100 | 0 | 67.12 | 83.69 | 90.39 | — | 122.43 |
| ingress_to_report_ack | 100 | 0 | 67.13 | 83.69 | 90.39 | — | 122.44 |
| ingress_queue | 100 | 0 | 3.10 | 4.13 | 4.25 | — | 12.27 |
| runtime_assembly | 100 | 0 | 0.02 | 0.03 | 0.04 | — | 0.07 |
| sandbox_provision | 100 | 0 | 0.10 | 0.31 | 0.45 | — | 0.95 |
| workspace_restore | 100 | 0 | 15.17 | 29.80 | 34.87 | — | 55.29 |
| pi_startup | 100 | 0 | 14.75 | 18.42 | 20.87 | — | 31.79 |
| mcp_startup | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.00 |
| model_ttft | 100 | 0 | 0.06 | 0.14 | 0.21 | — | 0.37 |
| tool_call | 100 | 0 | 0.27 | 0.44 | 0.51 | — | 0.62 |
| im_outbound | 100 | 0 | 0.29 | 0.65 | 1.02 | — | 6.64 |
| terminal_cleanup | 100 | 0 | 1.32 | 2.48 | 2.85 | — | 8.86 |
| checkpoint | 100 | 0 | 27.74 | 39.64 | 43.27 | — | 56.52 |
| report_ack | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.04 |

Resource profiles include failed attempts when the counter was observed. CPU is milliseconds; I/O is logical fixture bytes, not physical disk I/O.

| Resource | n | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: |
| parentCpuMs | 100 | 36.92 | 54.82 | 66.03 |
| workerCpuMs | 100 | 14.88 | 19.84 | 23.70 |
| logicalReadBytes | 100 | 4242235.00 | 4242236.00 | 4242236.00 |
| logicalWriteBytes | 100 | 4218295.00 | 4218296.00 | 4218296.00 |

## mcp-64k

Milliseconds; stage rows aggregate repeated calls within each successful attempt.

| Metric | n | Missing | P50 | P90 | P95 | P99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ingress_to_first_receipt | 100 | 0 | 19.30 | 23.27 | 27.19 | — | 43.69 |
| ingress_to_terminal | 100 | 0 | 21.00 | 26.09 | 29.46 | — | 45.70 |
| ingress_to_checkpoint | 100 | 0 | 23.70 | 31.30 | 34.85 | — | 68.10 |
| ingress_to_report_ack | 100 | 0 | 23.71 | 31.31 | 34.85 | — | 68.10 |
| ingress_queue | 100 | 0 | 3.13 | 4.27 | 4.31 | — | 11.62 |
| runtime_assembly | 100 | 0 | 0.02 | 0.04 | 0.04 | — | 0.06 |
| sandbox_provision | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.00 |
| workspace_restore | 100 | 0 | 0.64 | 2.05 | 2.67 | — | 13.69 |
| pi_startup | 100 | 0 | 14.50 | 17.51 | 20.21 | — | 30.70 |
| mcp_startup | 100 | 0 | 0.07 | 0.18 | 0.24 | — | 0.35 |
| model_ttft | 100 | 0 | 0.06 | 0.13 | 0.17 | — | 0.76 |
| tool_call | 100 | 0 | 0.28 | 0.46 | 0.53 | — | 0.83 |
| im_outbound | 100 | 0 | 0.30 | 0.61 | 0.82 | — | 1.47 |
| terminal_cleanup | 100 | 0 | 1.35 | 2.42 | 3.16 | — | 10.61 |
| checkpoint | 100 | 0 | 2.20 | 4.37 | 5.85 | — | 43.45 |
| report_ack | 100 | 0 | 0.00 | 0.00 | 0.00 | — | 0.01 |

Resource profiles include failed attempts when the counter was observed. CPU is milliseconds; I/O is logical fixture bytes, not physical disk I/O.

| Resource | n | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: |
| parentCpuMs | 100 | 3.64 | 6.54 | 18.09 |
| workerCpuMs | 100 | 14.84 | 19.09 | 21.12 |
| logicalReadBytes | 100 | 67046.00 | 67048.00 | 67048.00 |
| logicalWriteBytes | 100 | 66320.00 | 66322.00 | 66322.00 |

## injected-rejection

Milliseconds; stage rows aggregate repeated calls within each successful attempt.

| Metric | n | Missing | P50 | P90 | P95 | P99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ingress_to_first_receipt | 0 | 0 | — | — | — | — | — |
| ingress_to_terminal | 0 | 0 | — | — | — | — | — |
| ingress_to_checkpoint | 0 | 0 | — | — | — | — | — |
| ingress_to_report_ack | 0 | 0 | — | — | — | — | — |
| ingress_queue | 0 | 0 | — | — | — | — | — |
| runtime_assembly | 0 | 0 | — | — | — | — | — |
| sandbox_provision | 0 | 0 | — | — | — | — | — |
| workspace_restore | 0 | 0 | — | — | — | — | — |
| pi_startup | 0 | 0 | — | — | — | — | — |
| mcp_startup | 0 | 0 | — | — | — | — | — |
| model_ttft | 0 | 0 | — | — | — | — | — |
| tool_call | 0 | 0 | — | — | — | — | — |
| im_outbound | 0 | 0 | — | — | — | — | — |
| terminal_cleanup | 0 | 0 | — | — | — | — | — |
| checkpoint | 0 | 0 | — | — | — | — | — |
| report_ack | 0 | 0 | — | — | — | — | — |

Resource profiles include failed attempts when the counter was observed. CPU is milliseconds; I/O is logical fixture bytes, not physical disk I/O.

| Resource | n | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: |
| parentCpuMs | 1 | 1.70 | — | 1.70 |
| workerCpuMs | 0 | — | — | — |
| logicalReadBytes | 1 | 0.00 | — | 0.00 |
| logicalWriteBytes | 1 | 0.00 | — | 0.00 |

## injected-timeout

Milliseconds; stage rows aggregate repeated calls within each successful attempt.

| Metric | n | Missing | P50 | P90 | P95 | P99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ingress_to_first_receipt | 0 | 0 | — | — | — | — | — |
| ingress_to_terminal | 0 | 0 | — | — | — | — | — |
| ingress_to_checkpoint | 0 | 0 | — | — | — | — | — |
| ingress_to_report_ack | 0 | 0 | — | — | — | — | — |
| ingress_queue | 0 | 0 | — | — | — | — | — |
| runtime_assembly | 0 | 0 | — | — | — | — | — |
| sandbox_provision | 0 | 0 | — | — | — | — | — |
| workspace_restore | 0 | 0 | — | — | — | — | — |
| pi_startup | 0 | 0 | — | — | — | — | — |
| mcp_startup | 0 | 0 | — | — | — | — | — |
| model_ttft | 0 | 0 | — | — | — | — | — |
| tool_call | 0 | 0 | — | — | — | — | — |
| im_outbound | 0 | 0 | — | — | — | — | — |
| terminal_cleanup | 0 | 0 | — | — | — | — | — |
| checkpoint | 0 | 0 | — | — | — | — | — |
| report_ack | 0 | 0 | — | — | — | — | — |

Resource profiles include failed attempts when the counter was observed. CPU is milliseconds; I/O is logical fixture bytes, not physical disk I/O.

| Resource | n | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: |
| parentCpuMs | 1 | 1.90 | — | 1.90 |
| workerCpuMs | 0 | — | — | — |
| logicalReadBytes | 1 | 0.00 | — | 0.00 |
| logicalWriteBytes | 1 | 0.00 | — | 0.00 |

Whole-process peak RSS: 158676 KiB. This is cumulative, excludes child RSS and cannot be attributed to a scenario.
Linux cgroup cpu.stat, memory.peak, memory.events and io.stat snapshots are retained in the raw result for the whole container, including fixture setup and cleanup. Null means unavailable; memory.peak is not a per-sample delta.
