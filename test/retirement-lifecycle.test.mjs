import test from "node:test";
import assert from "node:assert/strict";
import {
  RETIREMENT_HOLD_MS,
  RETIREMENT_PREFIX,
  canArmRetirement,
  retirementReady,
  expectedRetirementName
} from "../src/retirement-guard.js";
import {
  retirementDisposition,
  canDeleteRegistryTombstone
} from "../src/corpus-retirement.js";

test("retirement accepts a preexisting ARQ_ prefix under NAO+INATIVO while preserving guards",()=>{
  assert.equal(canArmRetirement({
    desiredPresence:"ABSENT",state:"INACTIVE",
    registrySeenAt:1000,physicalEventAt:2000,
    preexistingPrefix:false,watchCovered:true
  }),true);
  assert.equal(canArmRetirement({
    desiredPresence:"ABSENT",state:"INACTIVE",
    registrySeenAt:1000,physicalEventAt:2000,
    preexistingPrefix:true,watchCovered:true
  }),true);
  assert.equal(expectedRetirementName("ABC"),RETIREMENT_PREFIX+"ABC");
});

test("retirement remains fail-closed until hold and all guards still match",()=>{
  const due=1000+RETIREMENT_HOLD_MS;
  assert.equal(retirementReady({
    now:due-1,dueAt:due,desiredPresence:"ABSENT",state:"INACTIVE",
    driveIdMatches:true,prefixMatches:true,watchCovered:true
  }),false);
  assert.equal(retirementReady({
    now:due,dueAt:due,desiredPresence:"ABSENT",state:"INACTIVE",
    driveIdMatches:true,prefixMatches:true,watchCovered:true
  }),true);
  assert.equal(retirementReady({
    now:due,dueAt:due,desiredPresence:"ABSENT",state:"INACTIVE",
    driveIdMatches:true,prefixMatches:false,watchCovered:true
  }),false);
});

test("physical retirement keeps tombstone when external relations survive",()=>{
  const readback={
    body_count:0,owned_relations:0,incoming_relations:3,
    revisions:0,sync_state:0,source_object:0,orphan_fts:0
  };
  assert.deepEqual(retirementDisposition(readback),{
    mode:"KEEP_TOMBSTONE_EXTERNAL_RELATIONS",incoming_relations:3
  });
  assert.equal(canDeleteRegistryTombstone(readback),false);
});

test("registry row is terminally deletable only after complete residue removal",()=>{
  const readback={
    body_count:0,owned_relations:0,incoming_relations:0,
    revisions:0,sync_state:0,source_object:0,orphan_fts:0
  };
  assert.deepEqual(retirementDisposition(readback),{mode:"DELETE_REGISTRY_LAST"});
  assert.equal(canDeleteRegistryTombstone(readback),true);
});
