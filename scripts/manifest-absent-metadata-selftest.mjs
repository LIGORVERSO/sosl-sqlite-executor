import { classifyManifestSource, requiresDriveMetadata } from "../src/local-manifest.mjs";

function assert(condition,message){
  if(!condition) throw new Error(message);
}

const absentIntent={desired_presence:"ABSENT",state:"INACTIVE"};
const inaccessibleMeta={error:"File not accessible",trashed:false};

assert(
  requiresDriveMetadata({code:"SUP0041",intent:absentIntent,row:null})===false,
  "ABSENT source without materialized body must not require Drive metadata"
);
assert(
  classifyManifestSource({
    code:"SUP0041",
    intent:absentIntent,
    row:null,
    meta:inaccessibleMeta,
    processedRevision:"",
    controlState:null
  })==="RETIRADO",
  "ABSENT source without body must remain RETIRADO even if Drive metadata is inaccessible"
);

const activeIntent={desired_presence:"PRESENT",state:"ACTIVE"};
assert(
  requiresDriveMetadata({code:"DOC_ACTIVE",intent:activeIntent,row:null})===true,
  "Active source must continue requiring Drive metadata"
);
assert(
  classifyManifestSource({
    code:"DOC_ACTIVE",
    intent:activeIntent,
    row:null,
    meta:inaccessibleMeta,
    processedRevision:"",
    controlState:null
  })==="ERRO_METADATA",
  "Active inaccessible source must remain a fatal metadata error"
);

const retiringRow={desired_presence:"ABSENT",state:"INACTIVE",body_present:1};
assert(
  requiresDriveMetadata({code:"DOC_WITH_BODY",intent:absentIntent,row:retiringRow})===true,
  "ABSENT source with materialized body must keep metadata validation"
);

console.log(JSON.stringify({
  contract:"sosl_manifest_absent_metadata_selftest_v1",
  ok:true,
  absent_without_body:"RETIRADO_WITHOUT_METADATA",
  active_inaccessible:"ERRO_METADATA_PRESERVED",
  absent_with_body:"METADATA_REQUIRED"
}));
