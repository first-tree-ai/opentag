# Independent SQL caller review: batches 19–25

The user-authorized read-only reviewer inspected exact committed ranges, source,
tests and evidence records without changing files or rerunning tests/Docker.

| Batch | Exact reviewed range | Result |
| --- | --- | --- |
| 19 | 7a257f49..b846c5e9aeaa153aba53fc06d930709bdac45ada | No actionable finding; LIMIT 1 bounds materialization, not history scans. |
| 20 initial | b846c5e9..3ff799ff0a793a017ba05eead251d948291df376 | P2: missing/file ancestors multiplied process launches; schema has no path-length bound. |
| 20 correction | 3ff799ff..7b1b81fea5e91d180bb3abfcdac4bd554508e35d | P2 closed; exact 040000 ancestor entry and two real-Git process trace controls. |
| 21 | 7b1b81fe..ac1b538f766442439a3575f21ceace86cf9d8d9e | No actionable finding; native close bounds and independent container cleanup retained. |
| 22 | ac1b538f..8ea19fd8ab248607ee536f6a3568092156f6c9a1 | No actionable finding for registry/store reclamation; async admission/drain remains IM-F3. |
| 23 initial | 8ea19fd8..4af455c0f5ff6aebc00154f8b3d506b04aa44a27 | P2: computer-kind read could resume into a new grant stage after close. |
| 23 correction | 4af455c0..0efff5241f288edb1f450b9247c2523640391375 | P2 closed; immediate closed/current recheck, proxy/legacy gated controls. |
| 24 initial | 0efff524..7493dd8c3177659e53921a199066590488e51c1b | Two P2: late maintenance adapter adoption; untracked card callbacks and late diagnostic SQL. |
| 24 correction | 7493dd8c..4d6969bdaa8b0998bb99084d782f249d8ba757a0 | Both closed; existing stop/epoch/signal fences, tracked card callbacks and three native controls. |
| 25 initial | 4d6969bd..a0d22e9bd31fa34fcf90bab774cb00ac524492f1 | P2: existing custody reads and complete Session-message admission/result omitted from work set. |
| 25 correction | a0d22e9b..0b09a346f8e4b1a38bd1e5942f6730cda728f197 | Closed; all three enter the existing owner, three gated controls and owning Docker matrix pass. |
| 26 | 0b09a346..8d5d88cec60afd0b247634f32e644576c25292f1 | No actionable finding; actual control, callback, business and disconnect work joined with existing scheduler counter. |
| 27 | 8d5d88ce..79c767d2fc5c1da27c89b219b7b2a01cc8a66c53 | No actionable finding; disconnected instances retained and joined, stop initiation independent, pinned WebSocket rejects late upgrades. |
| 28 initial | 79c767d2..0159bad5233576f6d25019779168c755820a1717 | Two P2: response rewrite could create handles after execution close; broker task policy omitted the cancellation signal. |
| 28 correction | 0159bad5..6c87b97c9bed04125bd98fcdd3ff051bed2d74c5 | Both closed; actual adapter/transport capture gates and broker-to-GitHub policy controls cover late handles and cancellation. |

The reviewer also checked the remaining shutdown design against pinned Fastify
5.12.3, Avvio 9.3.0 and websocket dependency source. Actual registration-time
onClose is LIFO; asynchronous execution child plugins register during boot.
Root preClose must initiate stop without blocking subsequent websocket close,
then onClose joins the retained operations before the earliest-registered final
SQL cleanup. Websocket close itself does not join callback SQL.

A loopback experiment with pinned Fastify/Node 24.20 confirmed that a client
which disconnects can leave its handler gated after app.close resolves. Therefore
complete Slack setup and Context Tree runs need a narrow explicit owner; normal
HTTP waits do not establish that drain for disconnected clients. These are design
review observations, not completed IM-F3 repair or full Server acceptance.

Batch 29 and later changes require their own exact-commit review. CI, merge,
deployment, private billing and live provider acceptance are not inferred.
