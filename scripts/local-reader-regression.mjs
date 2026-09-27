import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openLocalReader } from "../src/local-reader.mjs";
import { inspectReaderCapabilities } from "../src/reader-contract.mjs";

const dbPath=String(process.env.SOSL_SQLITE_PATH||"").trim();
if(!dbPath) throw new Error("SOSL_SQLITE_PATH required");

function refs(items){return new Set((items??[]).map(x=>String(x.stable_ref??x.sosl_code??"")));}
function assert(v,msg){if(!v)throw new Error(msg);}

function runCases(path){
  const reader=openLocalReader(path);
  try{
    const results={};
    results.caio=reader.resolveContext("Caio");
    assert(results.caio.context_status==="context_sufficient_for_interpretation","Caio status");
    assert(refs(results.caio.package.seeds).has("LPE001"),"Caio seed LPE001");

    results.lsi02=reader.resolveContext("LSI02");
    assert(refs(results.lsi02.package.seeds).has("LSI02"),"LSI02 seed");

    results.load=reader.resolveContext("Caio pode voar carregando Eduarda?");
    const loadSeeds=refs(results.load.package.seeds);
    const loadSources=refs(results.load.package.sources);
    assert(loadSeeds.has("LPE001")&&loadSeeds.has("LPE028"),"load seeds");
    assert(loadSources.has("LSI02"),"load LSI02 source");

    results.resurrection=reader.resolveContext("Caio pode ressuscitar Eduarda?");
    assert(results.resurrection.context_status==="context_sufficient_for_interpretation","resurrection status");
    assert(refs(results.resurrection.package.seeds).has("LPE028"),"resurrection Eduarda seed");

    results.transformation=reader.resolveContext("Caio pode se transformar mudando a cor do cabelo?");
    assert(refs(results.transformation.package.sources).has("LSI02"),"transformation LSI02");

    results.external=reader.resolveContext("Priscila pode ir com Sigfried à Lua?");
    assert(results.external.context_status==="incomplete_external_reference","external reference status");

    results.coverage=reader.resolveContext("Quais são todas as regras e condições do voo de Caio?");
    assert(results.coverage.context_status==="incomplete_coverage","coverage status");

    results.narrative=reader.resolveContext("vamos desenvolver o capítulo 4 de A Busca");
    assert(results.narrative.package?.selectors?.target_rt?.stable_ref==="H1RT004","narrative target H1RT004");

    return {
      statuses:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,v.context_status])),
      load_sources:[...loadSources].slice(0,16),
      narrative_target:results.narrative.package.selectors.target_rt.stable_ref
    };
  }finally{
    reader.close();
  }
}

const baseCapabilities=inspectReaderCapabilities(dbPath);
assert(baseCapabilities.compatible,"base DB incompatible");
const base=runCases(dbPath);

const dir=await mkdtemp(join(tmpdir(),"sosl-reader-version-independence-"));
const clone=join(dir,"alternate-version.db");
try{
  await copyFile(dbPath,clone);
  const db=new DatabaseSync(clone);
  try{
    db.exec("PRAGMA user_version=987654");
  }finally{db.close();}
  const altCapabilities=inspectReaderCapabilities(clone);
  assert(altCapabilities.compatible,"alternate-version DB incompatible");
  const alt=runCases(clone);
  assert(JSON.stringify(base.statuses)===JSON.stringify(alt.statuses),"status drift under DB user_version change");
  assert(base.narrative_target===alt.narrative_target,"narrative drift under DB user_version change");
  console.log(JSON.stringify({
    contract:"sosl_local_reader_regression_v1",
    ok:true,
    reader_contract:baseCapabilities.reader_contract,
    version_binding:baseCapabilities.version_binding,
    snapshot_hash_binding:baseCapabilities.snapshot_hash_binding,
    database_id_binding:baseCapabilities.database_id_binding,
    alternate_user_version:987654,
    cases:base
  },null,2));
}finally{
  await rm(dir,{recursive:true,force:true});
}
