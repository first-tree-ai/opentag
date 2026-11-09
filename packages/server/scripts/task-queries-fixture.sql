-- This fixture uses synthetic values and keeps all database constraints enabled.
-- Each application table has at least 100000 rows. Extra internal sessions model a hot tree.
create schema if not exists benchmark;
create or replace function benchmark.id(k integer, n bigint) returns uuid
language sql immutable strict as $$
  select (lpad(k::text, 8, '0') || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create or replace function benchmark.owner(n bigint) returns bigint
language sql immutable strict as $$
  select case when n=1 then 1 when n<=11 then 2 when n<=111 then 3 when n<=1111 then 4 else n end
$$;
create or replace function benchmark.message_session(n bigint) returns bigint
language sql immutable strict as $$
  select case when n%2=0 then 1 when n%4=1 then 2+(n/4)%10 else 12+(n/4)%99989 end
$$;
--> statement-breakpoint
insert into users(id,email,display_name,setup_completed_at)
select benchmark.id(1,n),'benchmark-'||n||'@example.invalid','Benchmark '||n,now() from generate_series(1,100000) n;
--> statement-breakpoint
insert into computers(id,owner_account_id,current_installation_id,display_name,platform,arch,client_version)
select benchmark.id(2,n),benchmark.id(1,benchmark.owner(n)),benchmark.id(3,n),'Computer '||n,'linux','arm64','0.0.0-benchmark' from generate_series(1,100000) n;
--> statement-breakpoint
insert into agents(id,created_by_user_id,computer_id,name,display_name,runtime_provider)
select benchmark.id(4,n),benchmark.id(1,benchmark.owner(n)),benchmark.id(2,n),'agent-'||n,'Agent '||n,'codex' from generate_series(1,100000) n;
--> statement-breakpoint
insert into slack_installations(id,agent_id,external_app_id,external_team_id,external_bot_id,credential_schema_version,credential_generation,encrypted_credential,activated_at)
select benchmark.id(5,n),benchmark.id(4,n),'app-'||n,'team-'||n,'bot-'||n,1,1,'synthetic-not-a-secret',now() from generate_series(1,100000) n;
--> statement-breakpoint
insert into im_bindings(id,agent_id,provider,status,external_app_id,external_bot_id,credential_schema_version,credential_generation,encrypted_credential,activated_at)
select benchmark.id(6,n),benchmark.id(4,n),'feishu','active','feishu-app-'||n,'bot-'||n,1,1,'synthetic-not-a-secret',now() from generate_series(1,100000) n;
--> statement-breakpoint
insert into sessions(id,im_binding_id,channel_id,conversation_kind,kind)
select benchmark.id(7,n),benchmark.id(6,n),'channel-'||n,case when n=1 then 'dm'::im_conversation_kind else 'channel'::im_conversation_kind end,'channel' from generate_series(1,100000) n;
--> statement-breakpoint
insert into sessions(id,im_binding_id,channel_id,conversation_kind,kind,created_by_session_id)
select benchmark.id(8,n),benchmark.id(6,1),'channel-1','dm','internal',benchmark.id(7,1) from generate_series(1,100000) n;
--> statement-breakpoint
insert into session_placements(session_id,computer_id,generation)
select benchmark.id(7,n),benchmark.id(2,n),1 from generate_series(1,100000) n;
--> statement-breakpoint
insert into im_messages(id,im_binding_id,channel_id,external_message_id,provider_revision_key,operation,direction,author_kind,author_external_id,content,occurred_at,provider_context)
select benchmark.id(9,n),benchmark.id(6,benchmark.message_session(n)),'channel-'||benchmark.message_session(n),'message-'||n,'original','created','inbound','human','synthetic-author',
jsonb_build_object('version',1,'fallbackText','Benchmark message '||n,'blocks',jsonb_build_array(jsonb_build_object('type','text','text','Benchmark message '||n)),'resources','[]'::jsonb),
'2026-10-26T07:00:00Z'::timestamptz-n*interval '10 seconds','{}'::jsonb from generate_series(1,100000) n;
--> statement-breakpoint
insert into im_message_deliveries(id,message_id,session_id,attention,state,placement_generation,input_hash,turn_id,report_owner_instance_id,result_hash,turn_report,reported_at,accepted_at,expires_at,execution_origin)
select benchmark.id(10,n),benchmark.id(9,n),benchmark.id(7,benchmark.message_session(n)),'direct','accepted',1,'synthetic-input-'||n,'turn-'||n,benchmark.id(11,1),'synthetic-result-'||n,
'{"outcome":"completed","usage":{"inputTokens":100,"cachedInputTokens":10,"outputTokens":20}}'::jsonb,
'2026-10-26T07:00:01Z'::timestamptz-n*interval '10 seconds','2026-10-26T07:00:00Z'::timestamptz-n*interval '10 seconds','2026-10-27T08:00:00Z','local' from generate_series(1,100000) n;
--> statement-breakpoint
insert into session_messages(id,source_session_id,target_session_id,content,content_hash,last_outcome,created_at)
select benchmark.id(12,n),benchmark.id(7,1),benchmark.id(8,n),'Synthetic internal task '||n,repeat('a',64),'accepted','2026-10-26T07:00:00Z'::timestamptz-n*interval '1 second' from generate_series(1,100000) n;
--> statement-breakpoint
insert into session_descendants(ancestor_session_id,descendant_session_id,depth,last_message_created_at,last_message_id,last_delivery_outcome,task_preview)
select benchmark.id(7,1),benchmark.id(8,n),1,'2026-10-26T07:00:00Z'::timestamptz-n*interval '1 second',benchmark.id(12,n),'accepted','Synthetic internal task '||n from generate_series(1,100000) n;
--> statement-breakpoint
insert into sandboxes(id,session_id,storage_uri)
select benchmark.id(13,n),benchmark.id(7,n),'gs://synthetic-benchmark/session-'||n from generate_series(1,100000) n;
--> statement-breakpoint
insert into computer_credentials(id,computer_id,secret_hash,issued_by_user_id)
select benchmark.id(14,n),benchmark.id(2,n),'synthetic-hash-'||n,benchmark.id(1,benchmark.owner(n)) from generate_series(1,100000) n;
--> statement-breakpoint
insert into account_cli_login_codes(id,token_hash,user_id,issued_by_user_id,expires_at)
select benchmark.id(15,n),'synthetic-login-'||n,benchmark.id(1,n),benchmark.id(1,n),now()+interval '1 day' from generate_series(1,100000) n;
--> statement-breakpoint
insert into auth_identities(id,user_id,provider,issuer,subject)
select benchmark.id(16,n),benchmark.id(1,n),'github','https://example.invalid','subject-'||n from generate_series(1,100000) n;
--> statement-breakpoint
insert into auth_sessions(id,user_id,token,expires_at)
select benchmark.id(17,n),benchmark.id(1,n),'synthetic-session-'||n,now()+interval '1 day' from generate_series(1,100000) n;
--> statement-breakpoint
insert into auth_verifications(id,identifier,value,expires_at)
select benchmark.id(18,n),'identifier-'||n,'synthetic-value-'||n,now()+interval '1 day' from generate_series(1,100000) n;
--> statement-breakpoint
insert into computer_connect_codes(id,token_hash,issued_by_account_id,mode,expires_at)
select benchmark.id(19,n),'synthetic-connect-'||n,benchmark.id(1,n),'create',now()+interval '1 day' from generate_series(1,100000) n;
--> statement-breakpoint
insert into agent_runtime_configs(agent_id,instructions)
select benchmark.id(4,n),'Synthetic runtime instructions' from generate_series(1,100000) n;
--> statement-breakpoint
insert into agent_schedules(id,agent_id,target_session_id,name,prompt,schedule,timezone,enabled)
select benchmark.id(20,n),benchmark.id(4,n),benchmark.id(7,n),'Schedule '||n,'Synthetic prompt','{"kind":"every","intervalSeconds":3600,"anchorAt":"2026-10-26T08:00:00Z"}'::jsonb,'UTC',false from generate_series(1,100000) n;
--> statement-breakpoint
insert into agent_skills(id,agent_id,name,description,source,object_key,archive_sha256,archive_bytes,file_count)
select benchmark.id(21,n),benchmark.id(4,n),'skill-'||n,'Synthetic skill','web_upload','synthetic/skill-'||n,repeat('a',64),1024,1 from generate_series(1,100000) n;
--> statement-breakpoint
insert into feishu_inbound_receipts(id,im_binding_id,credential_generation,event_id,status,processed_at)
select benchmark.id(22,n),benchmark.id(6,n),1,'event-'||n,'processed',now() from generate_series(1,100000) n;
--> statement-breakpoint
insert into github_connections(id,account_id,github_host,oauth_client_id)
select benchmark.id(23,n),benchmark.id(1,n),'github.com','synthetic-client' from generate_series(1,100000) n;
--> statement-breakpoint
insert into mcp_servers(id,account_id,name,url,default_auth_kind)
select benchmark.id(24,n),benchmark.id(1,benchmark.owner(n)),'MCP '||n,'https://example.invalid/mcp/'||n,'none' from generate_series(1,100000) n;
--> statement-breakpoint
insert into agent_mcp_servers(agent_id,mcp_server_id)
select benchmark.id(4,n),benchmark.id(24,n) from generate_series(1,100000) n;
--> statement-breakpoint
insert into mcp_client_registrations(id,account_id,authorization_server,source,client_id)
select benchmark.id(25,n),benchmark.id(1,n),'https://example.invalid/oauth','dcr','synthetic-client-'||n from generate_series(1,100000) n;
--> statement-breakpoint
insert into mcp_server_authorizations(id,mcp_server_id,agent_id,kind)
select benchmark.id(26,n),benchmark.id(24,n),benchmark.id(4,n),'none' from generate_series(1,100000) n;
--> statement-breakpoint
insert into runtime_approvals(id,server_instance_id,computer_id,instance_id,connection_id,im_binding_id,request,authority,expires_at)
select benchmark.id(27,n),benchmark.id(11,1),benchmark.id(2,n),benchmark.id(11,n),'synthetic-connection-'||n,benchmark.id(6,n),'{}'::jsonb,'{}'::jsonb,now()+interval '1 hour' from generate_series(1,100000) n;
--> statement-breakpoint
insert into runtime_durable_work(id,computer_id,kind,record_key,payload,status,attempts,accepted_at,updated_at)
select benchmark.id(28,n),benchmark.id(2,n),'session-message','synthetic-record-'||n,'{}'::jsonb,'succeeded',1,1793001600000,1793001600000 from generate_series(1,100000) n;
--> statement-breakpoint
insert into session_cli_proofs(session_id,proof_id,token_hash,placement_generation,connection_instance_id,computer_id)
select benchmark.id(7,n),benchmark.id(29,n),md5('proof-'||n)||md5('proof-tail-'||n),1,benchmark.id(11,n),benchmark.id(2,n) from generate_series(1,100000) n;
--> statement-breakpoint
insert into slack_oauth_nonces(id,nonce_hash,user_id,agent_id,intent,session_binding_hash,expires_at)
select benchmark.id(30,n),'synthetic-nonce-'||n,benchmark.id(1,benchmark.owner(n)),benchmark.id(4,n),'create','synthetic-binding-'||n,now()+interval '1 hour' from generate_series(1,100000) n;
--> statement-breakpoint
insert into slack_webhook_receipts(id,installation_id,credential_generation,event_id,status,processed_at)
select benchmark.id(31,n),benchmark.id(5,n),1,'slack-event-'||n,'processed',now() from generate_series(1,100000) n;
--> statement-breakpoint
insert into slack_working_targets(id,binding_id,installation_id,credential_generation,channel_id,thread_ts)
select 'target-'||n,benchmark.id(6,n),benchmark.id(5,n),1,'channel-'||n,'1700000000.'||lpad(n::text,6,'0') from generate_series(1,100000) n;
--> statement-breakpoint
insert into slack_working_turns(delivery_id,target_id,turn_id,sequence,phase,lease_expires_at,deadline_at)
select benchmark.id(10,n),'target-'||n,'turn-'||n,1,'working',now()+interval '1 hour',now()+interval '1 day' from generate_series(1,100000) n;
--> statement-breakpoint
insert into billing.accounts(id) select benchmark.id(1,n) from generate_series(1,100000) n;
--> statement-breakpoint
insert into billing.grants(id,account,amount,kind)
select 'grant-'||n,benchmark.id(1,n),1000000,'synthetic' from generate_series(1,100000) n;
--> statement-breakpoint
insert into billing.checkouts(id,account,amount_cents,session,payment)
select 'checkout-'||n,benchmark.id(1,n),1000,'checkout-session-'||n,'payment-'||n from generate_series(1,100000) n;
--> statement-breakpoint
insert into billing.payment_changes(payment) select 'payment-'||n from generate_series(1,100000) n;
--> statement-breakpoint
insert into billing.attempts(id,account,agent_id,session_id,source,gateway,model,state,resolution,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,priced_micros,debited_micros,created_at,finished_at)
select 'attempt-'||n,benchmark.id(1,benchmark.owner(benchmark.message_session(n))),benchmark.id(4,benchmark.message_session(n)),benchmark.id(7,benchmark.message_session(n)),
'execution','synthetic','synthetic-model','finalized','charged',100,10,0,20,100,100,
'2026-10-26T07:00:00Z'::timestamptz-n*interval '10 seconds','2026-10-26T07:00:01Z'::timestamptz-n*interval '10 seconds' from generate_series(1,100000) n;
--> statement-breakpoint
-- Fixture adaptation for the Task collaboration read: a Server-scheduled message carries no source
-- Session, so without one this benchmark would only exercise the source-Session branch.
insert into session_messages(id,source_session_id,scheduled_origin,target_session_id,content,content_hash,last_outcome,created_at)
select benchmark.id(32,n),null,
jsonb_build_object('scheduleId',benchmark.id(20,n),'scheduledFor','2026-10-26T07:30:00Z','timezone','UTC','name','Synthetic scheduled task'),
benchmark.id(8,n),'Synthetic scheduled collaboration '||n,repeat('b',64),'unknown',
'2026-10-26T07:00:00Z'::timestamptz-n*interval '1 second' from generate_series(1,50) n;
