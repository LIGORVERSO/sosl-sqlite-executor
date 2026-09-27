import test from "node:test";
import assert from "node:assert/strict";
import {
  compileCorpusRegistryIntent,
  membershipState,
  driveFileIdFromLocation
} from "../src/corpus-registry.js";
import { planCorpusReconciliation } from "../src/corpus-reconciler.js";

const bundle={
  sources:[{
    sosl_code:"KRG1",
    revision:"drive-version:915",
    tabs:[
      {title:"IDENTIDADES",rows:[
        {row_number:2,cells:{
          codigo_logico:"A1",
          localizacao_vigente:"https://docs.google.com/document/d/file-a/edit",
          entra_banco_estruturado:"SIM",
          status_banco_estruturado:"ATIVO"
        }},
        {row_number:3,cells:{
          codigo_logico:"OLD1",
          localizacao_vigente:"https://docs.google.com/document/d/file-old/edit",
          entra_banco_estruturado:"NAO",
          status_banco_estruturado:"INATIVO"
        }},
        {row_number:4,cells:{
          codigo_logico:"BAD1",
          localizacao_vigente:"https://docs.google.com/document/d/file-bad/edit",
          entra_banco_estruturado:"NAO",
          status_banco_estruturado:"ATIVO"
        }}
      ]},
      {title:"SUPORTES_PROVISORIOS",rows:[
        {row_number:2,cells:{
          id_suporte:"SUP0001",
          referencia_localizacao:"https://docs.google.com/spreadsheets/d/file-sup/edit",
          entra_banco_estruturado:"SIM",
          status_banco_estruturado:"INATIVO"
        }}
      ]}
    ]
  }]
};

test("membership grammar preserves the proven three valid states",()=>{
  assert.deepEqual(membershipState("SIM","ATIVO"),{desired_presence:"PRESENT",state:"ACTIVE"});
  assert.deepEqual(membershipState("SIM","INATIVO"),{desired_presence:"PRESENT",state:"INACTIVE"});
  assert.deepEqual(membershipState("NAO","INATIVO"),{desired_presence:"ABSENT",state:"INACTIVE"});
  assert.throws(()=>membershipState("NAO","ATIVO"),/INVALID_COMMAND_NAO_ATIVO/);
});

test("Drive locator parsing remains format-independent",()=>{
  assert.equal(driveFileIdFromLocation("https://docs.google.com/document/d/abc123/edit"),"abc123");
  assert.equal(driveFileIdFromLocation("https://drive.google.com/file/d/xyz789/view"),"xyz789");
});

test("KRG1 intent compiles without materializing KRG1 as corpus body",()=>{
  const intent=compileCorpusRegistryIntent(bundle);
  assert.equal(intent.krg1_revision,"drive-version:915");
  assert.deepEqual(intent.entries.map(x=>[x.sosl_code,x.desired_presence,x.state]),[
    ["A1","PRESENT","ACTIVE"],
    ["OLD1","ABSENT","INACTIVE"],
    ["SUP0001","PRESENT","INACTIVE"]
  ]);
  assert.equal(intent.invalid_commands.length,1);
  assert.equal(intent.invalid_commands[0].sosl_code,"BAD1");
});

test("reconciliation creates membership rows but preserves invalid commands fail-closed",()=>{
  const intent=compileCorpusRegistryIntent(bundle);
  const currentRegistry=[{
    sosl_code:"A1",source_id:"source-a",drive_file_id:"file-a",adapter:"google_doc_live_v2",
    registry_kind:"identity",desired_presence:"PRESENT",state:"ACTIVE",body_present:1,
    membership_source_revision:"drive-version:914",membership_source_locator:"old"
  }];
  const currentSources=[{
    sosl_code:"A1",source_id:"source-a",drive_file_id:"file-a",source_format:"google_doc_live_v2"
  }];
  const metadataByCode=new Map([
    ["SUP0001",{mime_type:"application/vnd.google-apps.spreadsheet"}]
  ]);
  const plan=planCorpusReconciliation({
    intent,currentRegistry,currentSources,metadataByCode,
    adapterForMime:mime=>mime.includes("spreadsheet")?"google_sheet_rows_live_v2":null
  });
  const a=plan.actions.find(x=>x.row?.sosl_code==="A1");
  const sup=plan.actions.find(x=>x.row?.sosl_code==="SUP0001");
  assert.equal(a.kind,"UPSERT");
  assert.equal(a.row.membership_source_revision,"drive-version:915");
  assert.equal(sup.kind,"UPSERT");
  assert.equal(sup.row.body_present,0);
  assert.equal(sup.row.state,"INACTIVE");
  assert.ok(plan.diagnostics.some(x=>x.kind==="INVALID_COMMAND_PRESERVED"&&x.sosl_code==="BAD1"));
});
