import { corpusSourceId } from "./corpus-registry.js";

function sameRow(a,b) {
  const keys=["sosl_code","source_id","drive_file_id","adapter","registry_kind","desired_presence","state","body_present","membership_source_revision","membership_source_locator"];
  return keys.every(key=>String(a?.[key]??"")===String(b?.[key]??""));
}

function sourceByCode(rows) {
  return new Map((rows??[]).map(row=>[String(row.sosl_code),row]));
}

export function planCorpusReconciliation({intent,currentRegistry,currentSources,metadataByCode=new Map(),adapterForMime,incomingRelationsByCode=new Map()}) {
  const registryByCode=sourceByCode(currentRegistry);
  const bodiesByCode=sourceByCode(currentSources);
  const intentByCode=sourceByCode(intent.entries);
  const invalidByCode=sourceByCode(intent.invalid_commands??[]);
  const actions=[], diagnostics=[];

  for(const invalid of intent.invalid_commands??[]) {
    diagnostics.push({kind:"INVALID_COMMAND_PRESERVED",sosl_code:invalid.sosl_code,reason:invalid.reason,entra:invalid.entra,status:invalid.status});
  }

  for(const current of currentRegistry??[]) {
    if(intentByCode.has(current.sosl_code)||invalidByCode.has(current.sosl_code)) continue;
    diagnostics.push({kind:"KRG1_ROW_MISSING_PRESERVED",sosl_code:current.sosl_code});
  }

  for(const entry of intent.entries) {
    const current=registryByCode.get(entry.sosl_code)??null;
    const body=bodiesByCode.get(entry.sosl_code)??null;

    if(current&&String(current.drive_file_id)!==entry.drive_file_id) {
      diagnostics.push({kind:"LOCATOR_CHANGE_PRESERVED",sosl_code:entry.sosl_code,old_drive_file_id:String(current.drive_file_id),new_drive_file_id:entry.drive_file_id});
      continue;
    }
    if(body&&String(body.drive_file_id)!==entry.drive_file_id) {
      diagnostics.push({kind:"BODY_LOCATOR_CHANGE_PRESERVED",sosl_code:entry.sosl_code,old_drive_file_id:String(body.drive_file_id),new_drive_file_id:entry.drive_file_id});
      continue;
    }

    if(entry.desired_presence==="ABSENT"&&!body) {
      if(current?.state==="RETIRING") {
        const incoming=Number(incomingRelationsByCode.get(entry.sosl_code)??0);
        if(incoming===0) {
          actions.push({kind:"DELETE",sosl_code:entry.sosl_code,reason:"TERMINAL_RETIREMENT_NO_EXTERNAL_RELATIONS"});
        } else {
          const desired={...current,desired_presence:"ABSENT",body_present:0,membership_source_revision:String(intent.krg1_revision),membership_source_locator:entry.registry_locator};
          if(!sameRow(current,desired)) actions.push({kind:"UPSERT",row:desired,reason:"RETAIN_RETIRING_TOMBSTONE"}); else actions.push({kind:"NOOP",sosl_code:entry.sosl_code,reason:"RETIRING_TOMBSTONE"});
        }
      } else if(current) {
        actions.push({kind:"DELETE",sosl_code:entry.sosl_code,reason:"ABSENT_AND_NO_BODY"});
      } else {
        actions.push({kind:"NOOP",sosl_code:entry.sosl_code,reason:"ABSENT_AND_NEVER_MATERIALIZED"});
      }
      continue;
    }

    const metadata=metadataByCode.get(entry.sosl_code)??null;
    const adapter=String(current?.adapter??body?.source_format??(metadata?adapterForMime(String(metadata.mime_type??"")):"")).trim();
    if(!adapter) {
      diagnostics.push({kind:"ADAPTER_MISSING_PRESERVED",sosl_code:entry.sosl_code});
      continue;
    }

    const desiredState=entry.desired_presence==="PRESENT"
      ? entry.state
      : (current?.state==="RETIRING"?"RETIRING":"INACTIVE");

    const desired={
      sosl_code:entry.sosl_code,
      source_id:String(current?.source_id??body?.source_id??corpusSourceId(entry.sosl_code)),
      drive_file_id:entry.drive_file_id,
      adapter,
      registry_kind:entry.registry_kind,
      desired_presence:entry.desired_presence,
      state:desiredState,
      body_present:body?1:0,
      membership_source_revision:String(intent.krg1_revision),
      membership_source_locator:entry.registry_locator
    };
    if(current&&sameRow(current,desired)) actions.push({kind:"NOOP",sosl_code:entry.sosl_code,reason:"ALREADY_CONVERGED"});
    else actions.push({kind:"UPSERT",row:desired,reason:current?"STATE_RECONCILED":"REGISTRY_ROW_CREATED"});
  }

  return {actions,diagnostics};
}
