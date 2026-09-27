import { discoverExecutionPlan } from "../src/control-discovery.mjs";
import { googleAccessTokenFromServiceAccountJson } from "../src/google-readonly.mjs";

const databaseId=String(process.env.SOSL_DATABASE_ID||"").trim();
if(!databaseId) throw new Error("SOSL_DATABASE_ID required");

const token=await googleAccessTokenFromServiceAccountJson(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly"
  ]
);
const plan=await discoverExecutionPlan(token);
const control=plan.control??{};
const candidates=plan.executor_candidates??[];
const active=String(control.active_executor||"NONE");
const executor=candidates.find(x=>String(x.executor_id)===active)??null;
const database=plan.databases.find(x=>x.database_id===databaseId)??null;

if(String(control.observer_enabled).toUpperCase()!=="TRUE"){
  throw new Error("CONTROL_GATE_OBSERVER_DISABLED");
}
if(String(control.dispatch_enabled).toUpperCase()!=="TRUE"){
  throw new Error("CONTROL_GATE_DISPATCH_DISABLED");
}
if(String(control.observer_mode).toUpperCase()==="DRY_RUN"){
  throw new Error("CONTROL_GATE_OBSERVER_DRY_RUN");
}
if(active==="NONE"||!executor){
  throw new Error("CONTROL_GATE_ACTIVE_EXECUTOR_MISSING");
}
if(String(executor.enabled).toUpperCase()!=="TRUE"){
  throw new Error("CONTROL_GATE_ACTIVE_EXECUTOR_DISABLED");
}
if(!database){
  throw new Error("CONTROL_GATE_DATABASE_DISABLED_OR_MISSING");
}

console.log(JSON.stringify({
  contract:"sosl_executor_activation_guard_v0.1.0",
  ok:true,
  database_id:databaseId,
  observer_enabled:control.observer_enabled,
  observer_mode:control.observer_mode,
  dispatch_enabled:control.dispatch_enabled,
  active_executor:active,
  executor_state:executor.state
},null,2));
