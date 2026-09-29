import { DatabaseSync } from "node:sqlite";
import { readKrg1DerivedControlState } from "./krg1-control-plane-local.mjs";

function s(v){ return String(v??""); }
function dbRows(db){
  return db.prepare(`
    SELECT r.sosl_code,r.source_id,r.drive_file_id,r.adapter,r.registry_kind,
           r.desired_presence,r.state,r.body_present,
           r.membership_source_revision,r.membership_source_locator,r.updated_at,
           ss.last_processed_revision,ss.last_sync_status
    FROM corpus_registry r
    LEFT JOIN v2_sync_state ss ON ss.source_id=r.source_id
    ORDER BY r.sosl_code
  `).all().map(r=>({
    sosl_code:s(r.sosl_code),
    source_id:s(r.source_id),
    drive_file_id:s(r.drive_file_id),
    adapter:s(r.adapter),
    registry_kind:s(r.registry_kind),
    desired_presence:s(r.desired_presence),
    state:s(r.state),
    body_present:Number(r.body_present),
    membership_source_revision:s(r.membership_source_revision),
    membership_source_locator:s(r.membership_source_locator),
    updated_at:s(r.updated_at),
    last_processed_revision:s(r.last_processed_revision),
    last_sync_status:s(r.last_sync_status)
  }));
}

async function safeDriveMeta(fileId,token,fetchImpl=fetch){
  const url=
    "https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(fileId)+
    "?fields=id,name,mimeType,version,modifiedTime,trashed&supportsAllDrives=true";
  const r=await fetchImpl(url,{headers:{authorization:"Bearer "+token}});
  const body=await r.json().catch(()=>({}));
  if(!r.ok){
    return {id:fileId,error:body?.error?.message??("HTTP_"+r.status)};
  }
  return {
    id:s(body.id),
    name:s(body.name),
    mime_type:s(body.mimeType),
    version:s(body.version),
    modified_time:s(body.modifiedTime),
    trashed:body.trashed===true,
    error:null
  };
}

function classify({code,intent,row,meta,processedRevision,controlState}){
  if(meta?.error) return "ERRO_METADATA";
  if(meta?.trashed) return "ERRO_TRASHED";

  const desired=s(intent?.desired_presence??row?.desired_presence);
  const state=s(intent?.state??row?.state);
  const body=Number(row?.body_present??0);
  const live=meta?.version ? "drive-version:"+s(meta.version) : "";

  if(code==="KRG1"){
    if(row) return "ERRO_KRG1_CORPUS_ANCHOR";
    if(!controlState) return "ERRO_CONTROLE_DERIVADO_AUSENTE";
    return live && live===s(controlState.processed_revision)
      ? "CONTROLE_DERIVADO_OK"
      : "CONTROLE_DERIVADO_DELTA";
  }

  if(!intent) {
    if(
      row &&
      s(row.desired_presence)==="PRESENT" &&
      s(row.state)==="INACTIVE" &&
      Number(row.body_present)===1
    ) return "CONGELADO_DIVERGENCIA_REGISTRAL";
    return "LEGADO_REVISAR";
  }
  if(desired==="ABSENT") return body===1?"RETIRADA_PENDENTE_CORPO":"RETIRADO";
  if(desired==="PRESENT"&&state==="INACTIVE"){
    return body===1?"CONGELADO_OK":"CONGELADO_SEM_CORPO";
  }
  if(desired!=="PRESENT"||state!=="ACTIVE") return "ESTADO_NAO_SUPORTADO";
  if(!row) return "NOVO";
  if(body!==1) return "SEM_CORPO";
  if(!processedRevision) return "SEM_REVISAO_PROCESSADA";
  if(live&&live!==processedRevision) return "DELTA";
  return "OK";
}

function isMaterialDelta({status,desired,state,body,liveRevision,processedRevision}){
  if(
    status==="CONGELADO_DIVERGENCIA_REGISTRAL" ||
    status==="CONGELADO_OK"
  ) return false;
  const directDirty=new Set([
    "ERRO_METADATA","ERRO_TRASHED","ERRO_KRG1_CORPUS_ANCHOR",
    "ERRO_CONTROLE_DERIVADO_AUSENTE","CONTROLE_DERIVADO_DELTA",
    "LEGADO_REVISAR","NOVO","SEM_CORPO","SEM_REVISAO_PROCESSADA",
    "DELTA","CONGELADO_SEM_CORPO","ESTADO_NAO_SUPORTADO"
  ]);
  if(directDirty.has(status)) return true;
  if(
    desired==="PRESENT" &&
    body===1 &&
    liveRevision &&
    processedRevision &&
    liveRevision!==processedRevision
  ) return true;
  if(desired==="ABSENT"&&body===1) return true;
  return false;
}

function globalRows(entries){
  return [["campo","valor","estado","observacao"],...entries];
}
function sourceRows(rows){
  return [[
    "codigo_logico","drive_file_id","nome_drive","modified_time_drive",
    "drive_revision","desired_presence","state","body_present",
    "db_processed_revision","db_sync_status","membership_revision",
    "registry_updated_at","estado_sync","meta_error",
    "ultima_verificacao","observacao"
  ],...rows];
}

export async function buildLocalManifest({
  dbPath,intent,liveKrg1Revision,driveToken,
  snapshot=null,fetchImpl=fetch
}){
  const db=new DatabaseSync(dbPath,{readOnly:true});
  let registryRows;
  try{ registryRows=dbRows(db); }
  finally{ db.close(); }

  const registryByCode=new Map(registryRows.map(x=>[x.sosl_code,x]));
  const intentByCode=new Map((intent?.entries??[]).map(x=>[s(x.sosl_code),x]));
  const allByCode=new Map();
  for(const entry of intent?.entries??[]){
    allByCode.set(s(entry.sosl_code),{
      code:s(entry.sosl_code),
      fileId:s(entry.drive_file_id),
      intent:entry
    });
  }
  for(const row of registryRows){
    if(!allByCode.has(row.sosl_code)){
      allByCode.set(row.sosl_code,{
        code:row.sosl_code,fileId:row.drive_file_id,intent:null
      });
    }
  }

  const items=[...allByCode.values()].sort((a,b)=>a.code.localeCompare(b.code));
  const metadata=[];
  for(let i=0;i<items.length;i+=20){
    const chunk=items.slice(i,i+20);
    metadata.push(...await Promise.all(
      chunk.map(x=>safeDriveMeta(x.fileId,driveToken,fetchImpl).then(meta=>({...x,meta})))
    ));
  }

  const controlState=readKrg1DerivedControlState({dbPath});
  const generatedAt=new Date().toISOString();
  const rows=[];
  const counts={};
  const fatalStates=[];
  let hasMaterialDelta=false;
  const fatalStatusSet=new Set([
    "ERRO_METADATA","ERRO_TRASHED","ERRO_KRG1_CORPUS_ANCHOR",
    "ERRO_CONTROLE_DERIVADO_AUSENTE","LEGADO_REVISAR",
    "NOVO","SEM_CORPO","SEM_REVISAO_PROCESSADA",
    "CONGELADO_SEM_CORPO","ESTADO_NAO_SUPORTADO"
  ]);

  for(const item of metadata){
    const code=item.code;
    const row=registryByCode.get(code)??null;
    const entry=intentByCode.get(code)??null;
    const desired=s(entry?.desired_presence??row?.desired_presence);
    const state=s(entry?.state??row?.state);
    const body=Number(row?.body_present??0);
    const liveRevision=item.meta?.version
      ? "drive-version:"+s(item.meta.version)
      : "";
    const processedRevision=code==="KRG1"
      ? s(controlState?.processed_revision)
      : s(row?.last_processed_revision);
    const syncStatus=code==="KRG1"
      ? s(controlState?.status)
      : s(row?.last_sync_status);
    const membershipRevision=code==="KRG1"
      ? s(controlState?.processed_revision)
      : s(row?.membership_source_revision);
    const status=classify({
      code,intent:entry,row,meta:item.meta,
      processedRevision,controlState
    });
    counts[status]=(counts[status]??0)+1;
    if(fatalStatusSet.has(status)) fatalStates.push({code,status});

    if(isMaterialDelta({
      status,desired,state,body,liveRevision,processedRevision
    })) hasMaterialDelta=true;

    rows.push([
      code,item.fileId,s(item.meta?.name),s(item.meta?.modified_time),
      liveRevision,desired,state,String(body),processedRevision,syncStatus,
      membershipRevision,s(row?.updated_at),status,s(item.meta?.error),
      generatedAt,""
    ]);
  }

  const liveRegistryRevision=s(liveKrg1Revision);
  const processedRegistryRevision=s(controlState?.processed_revision);
  if(!controlState||liveRegistryRevision!==processedRegistryRevision){
    hasMaterialDelta=true;
  }

  const global=[
    ["manifest_version","v0.4","ATIVO","Gerado do KRG1 vivo + Drive + SQLite local derivado."],
    ["generated_at",generatedAt,"OK","Manifesto reconstruível; não substitui autoridade viva."],
    ["authority_registry","KRG1","OK","KRG1 permanece autoridade registral externa ao corpo SQLite."],
    ["material_authority","Google Drive","OK","Metadados observados diretamente no Drive."],
    ["krg1_membership_revision",liveRegistryRevision,"OK","Revisão viva observada durante esta geração."],
    ["registry_rows",String(registryRows.length),"INFO","Linhas materiais em corpus_registry; KRG1 não é contado como corpo."],
    ["manifest_source_rows",String(rows.length),"INFO","União do KRG1 vivo com resíduos preservados no registro."],
    ["sync_counts",JSON.stringify(counts),"INFO","Contagem por estado_sync."],
    ["manifest_role","OBSERVABILIDADE","OK","Derivado e reconstruível."]
  ];

  if(snapshot){
    global.push(
      ["snapshot_status",hasMaterialDelta?"DIRTY":"PUBLISHED_CURRENT",hasMaterialDelta?"DELTA":"OK",
        hasMaterialDelta?"Há divergência viva posterior ou não absorvida pelo snapshot publicado.":"Snapshot publicado corresponde ao estado processado observado."],
      ["snapshot_version",s(snapshot.drive_version),"OK","Versão Drive confirmada por readback após upload."],
      ["snapshot_drive_file_id",s(snapshot.drive_file_id),"OK","ID estável do snapshot."],
      ["snapshot_generated_at",s(snapshot.generated_at),"OK","Data do bundle local."],
      ["snapshot_published_at",s(snapshot.published_at),"OK","Publicação confirmada por readback."],
      ["snapshot_format","ARTIFACT_BUNDLE","OK","ZIP externo com ZIP SQLite + metadata JSON."],
      ["snapshot_package_size_bytes",String(snapshot.package_size_bytes??""),"OK","Tamanho do bundle publicado."],
      ["snapshot_package_sha256",s(snapshot.package_sha256),"OK","SHA-256 do bundle validado por readback."],
      ["snapshot_inner_zip_size_bytes",String(snapshot.inner_zip_size_bytes??""),"OK","Tamanho do ZIP SQLite interno."],
      ["snapshot_inner_zip_sha256",s(snapshot.inner_zip_sha256),"OK","SHA-256 do ZIP SQLite interno."],
      ["snapshot_sqlite_size_bytes",String(snapshot.sqlite_size_bytes??""),"OK","Tamanho do SQLite."],
      ["snapshot_sqlite_sha256",s(snapshot.sqlite_sha256),"OK","SHA-256 do SQLite."],
      ["snapshot_integrity_check",s(snapshot.integrity_check),"OK","PRAGMA integrity_check no build local."],
      ["snapshot_counts",JSON.stringify(snapshot.counts??{}),"INFO","Contagens do SQLite publicado."],
      ["snapshot_builder","LOCAL_INCREMENTAL","OK","Builder local sem runtime remoto persistente."],
      ["snapshot_krg1_membership_revision",processedRegistryRevision,
        hasMaterialDelta?"DELTA":"OK",
        "Revisão do KRG1 efetivamente processada dentro deste snapshot; usada para ack registral."
      ]
    );
  }else{
    global.push(
      ["snapshot_status","BUILD_READY_NOT_PUBLISHED","INFO","Prévia local; nenhuma publicação foi reconhecida."],
      ["snapshot_krg1_membership_revision","","INFO","Só é preenchida após upload e readback do snapshot."]
    );
  }

  return {
    contract:"sosl_local_manifest_v0.4.0",
    generated_at:generatedAt,
    has_material_delta:hasMaterialDelta,
    live_krg1_revision:liveRegistryRevision,
    processed_krg1_revision:processedRegistryRevision,
    sync_counts:counts,
    fatal_states:fatalStates,
    has_fatal_state:fatalStates.length>0,
    global_values:globalRows(global),
    source_values:sourceRows(rows)
  };
}

function cell(value){
  return {userEnteredValue:{stringValue:s(value)}};
}
function rowsData(values){
  return values.map(row=>({values:row.map(cell)}));
}

export async function writeManifestAtomic({
  spreadsheetId,manifest,accessToken,fetchImpl=fetch
}){
  const metaUrl=
    "https://sheets.googleapis.com/v4/spreadsheets/"+
    encodeURIComponent(spreadsheetId)+
    "?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))";
  const metaRes=await fetchImpl(metaUrl,{headers:{authorization:"Bearer "+accessToken}});
  const meta=await metaRes.json().catch(()=>({}));
  if(!metaRes.ok) throw new Error("MANIFEST_METADATA_FAILED "+metaRes.status);
  const byTitle=new Map((meta.sheets??[]).map(x=>[x.properties?.title,x.properties]));
  const globalSheet=byTitle.get("ESTADO_GLOBAL");
  const sourceSheet=byTitle.get("FONTES");
  if(!globalSheet||!sourceSheet) throw new Error("MANIFEST_REQUIRED_SHEET_MISSING");

  const requests=[
    {
      updateCells:{
        range:{
          sheetId:Number(globalSheet.sheetId),
          startRowIndex:0,
          endRowIndex:Math.max(Number(globalSheet.gridProperties?.rowCount??1000),1000),
          startColumnIndex:0,
          endColumnIndex:4
        },
        rows:rowsData(manifest.global_values),
        fields:"userEnteredValue"
      }
    },
    {
      updateCells:{
        range:{
          sheetId:Number(sourceSheet.sheetId),
          startRowIndex:0,
          endRowIndex:Math.max(Number(sourceSheet.gridProperties?.rowCount??1000),1000),
          startColumnIndex:0,
          endColumnIndex:16
        },
        rows:rowsData(manifest.source_values),
        fields:"userEnteredValue"
      }
    }
  ];

  const url=
    "https://sheets.googleapis.com/v4/spreadsheets/"+
    encodeURIComponent(spreadsheetId)+":batchUpdate";
  const r=await fetchImpl(url,{
    method:"POST",
    headers:{
      authorization:"Bearer "+accessToken,
      "content-type":"application/json"
    },
    body:JSON.stringify({
      includeSpreadsheetInResponse:false,
      requests
    })
  });
  const body=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error("MANIFEST_ATOMIC_WRITE_FAILED "+r.status+" "+JSON.stringify(body));
  return {ok:true,request_count:requests.length};
}
