import assert from "node:assert/strict";
import { planCorpusReconciliation } from "../src/corpus-reconciler.js";
import { membershipState } from "../src/corpus-registry.js";
import { RETIREMENT_PREFIX, canArmRetirement } from "../src/retirement-guard.js";

const currentRegistry=[
  {
    sosl_code:"SUP_A",source_id:"source-a",drive_file_id:"file-a",
    adapter:"google_doc_live_v2",registry_kind:"provisional_support",
    desired_presence:"PRESENT",state:"ACTIVE",body_present:1,
    membership_source_revision:"drive-version:1",
    membership_source_locator:"KRG1:SUPORTES_PROVISORIOS:row:10"
  },
  {
    sosl_code:"DOC_B",source_id:"source-b",drive_file_id:"file-b",
    adapter:"google_doc_live_v2",registry_kind:"identity",
    desired_presence:"PRESENT",state:"ACTIVE",body_present:1,
    membership_source_revision:"drive-version:1",
    membership_source_locator:"KRG1:IDENTIDADES:row:20"
  }
];
const currentSources=[
  {sosl_code:"SUP_A",source_id:"source-a",drive_file_id:"file-a",source_format:"google_doc_live_v2"},
  {sosl_code:"DOC_B",source_id:"source-b",drive_file_id:"file-b",source_format:"google_doc_live_v2"}
];
const intent={
  krg1_revision:"drive-version:2",
  invalid_commands:[],
  entries:[{
    sosl_code:"DOC_B",drive_file_id:"file-b",registry_kind:"identity",
    registry_locator:"KRG1:IDENTIDADES:row:20",
    desired_presence:"PRESENT",state:"ACTIVE"
  }]
};
const plan=planCorpusReconciliation({
  intent,currentRegistry,currentSources,
  adapterForMime:()=>null
});

assert.deepEqual(
  plan.diagnostics.map(x=>[x.kind,x.sosl_code]),
  [["KRG1_ROW_MISSING_PRESERVED","SUP_A"]]
);
const freeze=plan.actions.find(x=>x.row?.sosl_code==="SUP_A");
assert.equal(freeze?.kind,"UPSERT");
assert.equal(freeze?.row?.desired_presence,"PRESENT");
assert.equal(freeze?.row?.state,"INACTIVE");
assert.equal(freeze?.row?.body_present,1);

const independent=plan.actions.find(x=>x.row?.sosl_code==="DOC_B");
assert.equal(independent?.kind,"UPSERT");
assert.equal(independent?.row?.state,"ACTIVE");
assert.equal(independent?.row?.membership_source_revision,"drive-version:2");

const secondRegistry=[
  freeze.row,
  independent.row
];
const second=planCorpusReconciliation({
  intent,currentRegistry:secondRegistry,currentSources,
  adapterForMime:()=>null
});
assert.equal(second.diagnostics.length,1);
assert.equal(second.actions.filter(x=>x.kind!=="NOOP").length,0);

assert.deepEqual(
  membershipState("NAO","INATIVO"),
  {desired_presence:"ABSENT",state:"INACTIVE"}
);
assert.equal(RETIREMENT_PREFIX,"ARQ_");
assert.equal(canArmRetirement({
  desiredPresence:"ABSENT",
  state:"INACTIVE",
  registrySeenAt:200,
  physicalEventAt:100,
  preexistingPrefix:true,
  watchCovered:true
}),true);

console.log(JSON.stringify({
  contract:"sosl_localized_freeze_selftest_v1",
  ok:true,
  diagnostic:plan.diagnostics[0],
  frozen_code:freeze.row.sosl_code,
  independent_code:independent.row.sosl_code,
  retirement_prefix:RETIREMENT_PREFIX
}));
