import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";

export function deliveryTestId(label: string, n = 0) {
  const hex = createHash("md5").update(`query-${label}:${n}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Synthetic history, a busy Local Agent, and an independent runnable Agent. No provider calls. */
export async function seedDeliveryQuery(database: DatabaseClient, history = 0, blocked = 0) {
  await database.execute(sql`
    insert into users(id,email,display_name) values (${deliveryTestId("user")},'query@example.test','Query test')
  `);
  await database.execute(sql`
    insert into computers(id,owner_account_id,kind,current_installation_id,display_name,platform,arch,client_version)
    select md5('query-computer:'||i)::uuid,${deliveryTestId("user")}::uuid,'local',
      md5('query-installation:'||i)::uuid,'Query test','linux','arm64','test' from generate_series(0,1) i
  `);
  await database.execute(sql`
    insert into agents(id,created_by_user_id,computer_id,name,display_name,runtime_provider)
    select md5('query-agent:'||i)::uuid,${deliveryTestId("user")}::uuid,
      md5('query-computer:'||i)::uuid,'query-'||i,'Query test','pi' from generate_series(0,1) i
  `);
  await database.execute(sql`
    insert into im_bindings(id,agent_id,provider,status,external_app_id,external_bot_id,
      credential_schema_version,credential_generation,encrypted_credential,activated_at)
    select md5('query-binding:'||i)::uuid,md5('query-agent:'||i)::uuid,'feishu','active',
      'query-app-'||i,'bot',1,1,'synthetic',now() from generate_series(0,1) i
  `);
  await database.execute(sql`
    insert into sessions(id,im_binding_id,channel_id,conversation_kind,kind)
    select md5('query-session:'||i)::uuid,md5('query-binding:'||(i/2))::uuid,'query-'||i,'channel','channel'
    from generate_series(0,3) i
  `);
  await database.execute(sql`
    insert into session_placements(session_id,computer_id,generation)
    select md5('query-session:'||i)::uuid,md5('query-computer:'||(i/2))::uuid,1 from generate_series(0,3) i
  `);
  await database.execute(sql`
    with spec as (
      select i,1 as sid from generate_series(1,${history}::int+${blocked}::int) i
      union all select ${history + blocked + 1}::int,0
      union all select ${history + blocked + 2}::int,2
    ) insert into im_messages(id,im_binding_id,channel_id,external_message_id,provider_revision_key,
      operation,direction,author_kind,author_external_id,content,provider_context,occurred_at)
    select md5('query-message:'||i)::uuid,md5('query-binding:'||(sid/2))::uuid,'query-'||sid,'query-'||i,
      '1','created','inbound','human','test','{"fallbackText":"Synthetic query test"}',
      '{"provider":"feishu"}',now()-interval '1 day'+i*interval '1 microsecond' from spec
  `);
  await database.execute(sql`
    with spec as (
      select i,1 as sid,true as history,false as occupant from generate_series(1,${history}::int) i
      union all select i+${history}::int,1,false,false from generate_series(1,${blocked}::int) i
      union all select ${history + blocked + 1}::int,0,false,true
      union all select ${history + blocked + 2}::int,2,false,false
    ) insert into im_message_deliveries(id,message_id,session_id,attention,state,placement_generation,
      input_hash,turn_id,report_owner_instance_id,accepted_at,reported_at,turn_report,result_hash,
      next_attempt_at,expires_at,last_error_code)
    select md5('query-delivery:'||i)::uuid,md5('query-message:'||i)::uuid,md5('query-session:'||sid)::uuid,
      'direct',case when history then 'accepted'::im_delivery_state else 'pending'::im_delivery_state end,1,
      case when history then 'hash' end,case when history then 'turn-'||i end,
      case when history then md5('query-owner:'||i)::uuid end,
      case when history then now()-interval '1 day' end,case when history then now()-interval '1 hour' end,
      case when history then '{}'::jsonb end,case when history then 'hash' end,
      case when occupant then now()+interval '1 hour'
        else date_trunc('seconds',now()-interval '1 hour')+i*interval '1 microsecond' end,
      now()+interval '1 day',case when occupant then 'IM_DELIVERY_CLAIM_test' end from spec
  `);
  // Cloud head plans read both tables; neither may depend on background auto-analyze timing.
  await database.execute(sql`analyze im_messages`);
  await database.execute(sql`analyze im_message_deliveries`);
  return {
    deliveryId: deliveryTestId("delivery", history + blocked + 2),
    occupantId: deliveryTestId("delivery", history + blocked + 1),
    agentId: deliveryTestId("agent", 1),
    sessionId: deliveryTestId("session", 2),
    computerId: deliveryTestId("computer", 1),
  };
}
