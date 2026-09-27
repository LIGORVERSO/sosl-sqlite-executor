import test from "node:test";
import assert from "node:assert/strict";
import { writeManifestAtomic } from "../src/local-manifest.mjs";

test("manifest writer commits ESTADO_GLOBAL and FONTES in one Sheets batchUpdate",async()=>{
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    calls.push({url:String(url),options});
    if(calls.length===1){
      return {
        ok:true,
        async json(){return {sheets:[
          {properties:{sheetId:11,title:"ESTADO_GLOBAL",gridProperties:{rowCount:100,columnCount:4}}},
          {properties:{sheetId:22,title:"FONTES",gridProperties:{rowCount:500,columnCount:14}}}
        ]};}
      };
    }
    assert.match(String(url),/:batchUpdate$/);
    assert.equal(options.method,"POST");
    const body=JSON.parse(options.body);
    assert.equal(body.requests.length,2);
    assert.equal(body.requests[0].updateCells.range.sheetId,11);
    assert.equal(body.requests[1].updateCells.range.sheetId,22);
    assert.equal(body.requests[0].updateCells.range.endColumnIndex,4);
    assert.equal(body.requests[1].updateCells.range.endColumnIndex,14);
    assert.equal(body.requests[0].updateCells.rows[0].values[0].userEnteredValue.stringValue,"campo");
    assert.equal(body.requests[1].updateCells.rows[0].values[0].userEnteredValue.stringValue,"codigo_logico");
    return {ok:true,async json(){return {replies:[{},{}]};}};
  };

  const result=await writeManifestAtomic({
    spreadsheetId:"manifest-test",
    accessToken:"token",
    fetchImpl,
    manifest:{
      global_values:[["campo","valor","estado","observacao"],["snapshot_status","PUBLISHED_CURRENT","OK","x"]],
      source_values:[[
        "codigo_logico","drive_file_id","nome_drive","modified_time_drive",
        "drive_revision","desired_presence","state","body_present",
        "db_processed_revision","db_sync_status","membership_revision",
        "registry_updated_at","estado_sync","meta_error"
      ],["A","id","name","time","drive-version:1","PRESENT","ACTIVE","1","drive-version:1","verified","r","u","OK",""]]
    }
  });
  assert.deepEqual(result,{ok:true,request_count:2});
  assert.equal(calls.length,2);
});
