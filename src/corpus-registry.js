import { createHash } from "node:crypto";

function hash(...parts) {
  return createHash("sha256").update(parts.map(String).join("\u001f"), "utf8").digest("hex");
}

export function corpusSourceId(soslCode) {
  const code=String(soslCode??"").trim();
  if(!code) throw new Error("CORPUS_REGISTRY_CODE_MISSING");
  return `source-${hash("source",code).slice(0,40)}`;
}

export function driveFileIdFromLocation(location) {
  const value=String(location??"").trim();
  if(!value) return null;
  const match=value.match(/\/(?:document|spreadsheets|presentation)\/d\/([^/?#]+)/i)||value.match(/\/file\/d\/([^/?#]+)/i);
  return match?.[1]??null;
}

export function membershipState(entraRaw,statusRaw) {
  const entra=String(entraRaw??"").trim().toUpperCase();
  const status=String(statusRaw??"").trim().toUpperCase();
  if(entra==="SIM"&&status==="ATIVO") return {desired_presence:"PRESENT",state:"ACTIVE"};
  if(entra==="SIM"&&status==="INATIVO") return {desired_presence:"PRESENT",state:"INACTIVE"};
  if(entra==="NAO"&&status==="INATIVO") return {desired_presence:"ABSENT",state:"INACTIVE"};
  if(entra==="NAO"&&status==="ATIVO") throw new Error("CORPUS_REGISTRY_INVALID_COMMAND_NAO_ATIVO");
  if(!entra&&!status) return null;
  throw new Error(`CORPUS_REGISTRY_UNSUPPORTED_MEMBERSHIP ${entra||"<VAZIO>"}+${status||"<VAZIO>"}`);
}

function tab(source,title) {
  return source?.tabs?.find(item=>item.title===title)??null;
}

function rowDecision({code,driveLocation,registryKind,registryLocator,entra,status}) {
  if(!code) return null;
  let membership;
  try {
    membership=membershipState(entra,status);
  } catch(error) {
    return {
      invalid:true,
      sosl_code:code,
      registry_kind:registryKind,
      registry_locator:registryLocator,
      entra:String(entra??"").trim().toUpperCase(),
      status:String(status??"").trim().toUpperCase(),
      reason:error instanceof Error?error.message:String(error)
    };
  }
  if(!membership) return null;
  const driveFileId=driveFileIdFromLocation(driveLocation);
  if(!driveFileId) throw new Error(`${code}: CORPUS_REGISTRY_DRIVE_ID_UNRESOLVED`);
  return {
    invalid:false,
    sosl_code:code,
    drive_file_id:driveFileId,
    registry_kind:registryKind,
    registry_locator:registryLocator,
    ...membership
  };
}

function identityDecision(row) {
  const code=String(row.cells?.codigo_logico??"").trim();
  if(!code||code==="codigo_logico") return null;
  return rowDecision({
    code,
    driveLocation:row.cells?.localizacao_vigente,
    registryKind:"identity",
    registryLocator:`KRG1:IDENTIDADES:row:${row.row_number}`,
    entra:row.cells?.entra_banco_estruturado,
    status:row.cells?.status_banco_estruturado
  });
}

function provisionalDecision(row) {
  const code=String(row.cells?.id_suporte??"").trim();
  if(!code||code==="id_suporte") return null;
  return rowDecision({
    code,
    driveLocation:row.cells?.referencia_localizacao,
    registryKind:"provisional_support",
    registryLocator:`KRG1:SUPORTES_PROVISORIOS:row:${row.row_number}`,
    entra:row.cells?.entra_banco_estruturado,
    status:row.cells?.status_banco_estruturado
  });
}

export function compileCorpusRegistryIntent(bundle) {
  const source=bundle?.sources?.find(item=>item.sosl_code==="KRG1");
  if(!source) throw new Error("CORPUS_REGISTRY_KRG1_MISSING");
  const identities=tab(source,"IDENTIDADES");
  const provisional=tab(source,"SUPORTES_PROVISORIOS");
  if(!identities||!provisional) throw new Error("CORPUS_REGISTRY_REQUIRED_TABS_MISSING");
  const entries=[], invalid_commands=[];
  for(const row of identities.rows??[]){
    const decision=identityDecision(row);
    if(!decision) continue;
    if(decision.invalid) invalid_commands.push(decision); else entries.push(decision);
  }
  for(const row of provisional.rows??[]){
    const decision=provisionalDecision(row);
    if(!decision) continue;
    if(decision.invalid) invalid_commands.push(decision); else entries.push(decision);
  }
  const seenCodes=new Set(), seenDrive=new Set();
  for(const entry of entries){
    if(seenCodes.has(entry.sosl_code)) throw new Error(`${entry.sosl_code}: CORPUS_REGISTRY_DUPLICATE_CODE`);
    if(seenDrive.has(entry.drive_file_id)) throw new Error(`${entry.sosl_code}: CORPUS_REGISTRY_DUPLICATE_DRIVE_ID`);
    seenCodes.add(entry.sosl_code);seenDrive.add(entry.drive_file_id);
  }
  for(const invalid of invalid_commands){
    if(seenCodes.has(invalid.sosl_code)) throw new Error(`${invalid.sosl_code}: CORPUS_REGISTRY_DUPLICATE_CODE`);
    seenCodes.add(invalid.sosl_code);
  }
  entries.sort((a,b)=>a.sosl_code.localeCompare(b.sosl_code));
  invalid_commands.sort((a,b)=>a.sosl_code.localeCompare(b.sosl_code));
  return {krg1_revision:source.revision,entries,invalid_commands};
}

export function buildCorpusRegistryProjection({intent,currentSources,missingMetadataByCode=new Map(),adapterForMime}) {
  if((intent.invalid_commands??[]).length) throw new Error(`CORPUS_REGISTRY_BOOTSTRAP_INVALID_COMMANDS ${JSON.stringify(intent.invalid_commands)}`);
  const currentByCode=new Map((currentSources??[]).map(row=>[String(row.sosl_code),row]));
  const intentByCode=new Map(intent.entries.map(row=>[row.sosl_code,row]));
  const unmappedCurrent=[];
  for(const current of currentSources??[]) if(!intentByCode.has(String(current.sosl_code))) unmappedCurrent.push(String(current.sosl_code));
  if(unmappedCurrent.length) throw new Error(`CORPUS_REGISTRY_CURRENT_SOURCE_NOT_IN_KRG1 ${JSON.stringify(unmappedCurrent.sort())}`);

  const rows=[];
  for(const entry of intent.entries){
    const current=currentByCode.get(entry.sosl_code)??null;
    if(entry.desired_presence==="ABSENT"&&!current) continue;
    if(current&&String(current.drive_file_id)!==entry.drive_file_id) throw new Error(`${entry.sosl_code}: CORPUS_REGISTRY_DRIVE_ID_MISMATCH`);
    const metadata=missingMetadataByCode.get(entry.sosl_code)??null;
    const adapter=current?.source_format??(metadata?adapterForMime(String(metadata.mime_type??"")):null);
    if(!adapter) throw new Error(`${entry.sosl_code}: CORPUS_REGISTRY_ADAPTER_MISSING`);
    rows.push({
      sosl_code:entry.sosl_code,
      source_id:String(current?.source_id??corpusSourceId(entry.sosl_code)),
      drive_file_id:entry.drive_file_id,
      adapter:String(adapter),
      registry_kind:entry.registry_kind,
      desired_presence:entry.desired_presence,
      state:entry.state,
      body_present:current?1:0,
      membership_source_revision:String(intent.krg1_revision),
      membership_source_locator:entry.registry_locator
    });
  }
  rows.sort((a,b)=>a.sosl_code.localeCompare(b.sosl_code));
  return rows;
}
