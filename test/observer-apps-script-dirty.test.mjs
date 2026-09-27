import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function observerContext() {
  const source=await readFile(new URL("../apps-script/observer-v0.2.1/Code.gs",import.meta.url),"utf8");
  const context={console};
  vm.createContext(context);
  vm.runInContext(source,context,{filename:"Code.gs"});
  return context;
}

test("actual Apps Script keeps dirty when manifest is stale",async()=>{
  const ctx=await observerContext();
  const state={dirty:{}};
  ctx.markDirty_(state,"gil-main","TEST","MIGRATION_REVISION_MISMATCH",1000,"drive-version:23");
  const plan={databasePlans:{
    "gil-main":{
      registryId:"KRG1",
      manifestByFileId:{
        TEST:{drive_revision:"drive-version:20",db_processed_revision:"drive-version:20",db_sync_status:"verified_live"}
      }
    }
  }};
  assert.equal(ctx.clearAcknowledged_(state,plan),0);
  assert.equal(state.dirty["gil-main"].files.TEST.observedRevision,"drive-version:23");
});

test("actual Apps Script clears only after exact observed revision is processed",async()=>{
  const ctx=await observerContext();
  const state={dirty:{}};
  ctx.markDirty_(state,"gil-main","TEST","SOURCE_CHANGED",1000,"drive-version:23");
  const plan={databasePlans:{
    "gil-main":{
      registryId:"KRG1",
      manifestByFileId:{
        TEST:{drive_revision:"drive-version:23",db_processed_revision:"drive-version:23",db_sync_status:"verified_live"}
      }
    }
  }};
  assert.equal(ctx.clearAcknowledged_(state,plan),1);
  assert.equal(state.dirty["gil-main"],undefined);
});


test("retirement pending source remains watched",async()=>{
  const ctx=await observerContext();
  assert.equal(ctx.sourceClass_({
    desired_presence:"ABSENT",
    state:"INACTIVE",
    body_present:"1",
    estado_sync:"RETIRADA_PENDENTE_CORPO"
  }),"RETIREMENT_PENDING");
});

test("retirement pending dirty is not acknowledged before lifecycle completion",async()=>{
  const ctx=await observerContext();
  const state={dirty:{}};
  ctx.markDirty_(state,"gil-main","RET","SOURCE_CHANGED",1000,"drive-version:31");
  const plan={databasePlans:{
    "gil-main":{
      registryId:"KRG1",
      manifestByFileId:{
        RET:{drive_revision:"drive-version:31",db_processed_revision:"drive-version:31",db_sync_status:"RETIRADA_PENDENTE_CORPO"}
      }
    }
  }};
  assert.equal(ctx.clearAcknowledged_(state,plan),0);
  assert.equal(state.dirty["gil-main"].files.RET.observedRevision,"drive-version:31");
});


test("registry dirty is not acknowledged by an unpublished live revision",async()=>{
  const ctx=await observerContext();
  const state={dirty:{}};
  ctx.markDirty_(state,"gil-main","KRG1","REGISTRY_CHANGED",1000,"drive-version:930");
  const plan={databasePlans:{
    "gil-main":{
      registryId:"KRG1",
      registryProcessedRevision:"drive-version:930",
      snapshotStatus:"DIRTY",
      manifestByFileId:{}
    }
  }};
  assert.equal(ctx.clearAcknowledged_(state,plan),0);
  assert.equal(state.dirty["gil-main"].files.KRG1.observedRevision,"drive-version:930");
});

test("registry dirty clears only after published snapshot carries exact KRG1 revision",async()=>{
  const ctx=await observerContext();
  const state={dirty:{}};
  ctx.markDirty_(state,"gil-main","KRG1","REGISTRY_CHANGED",1000,"drive-version:930");
  const plan={databasePlans:{
    "gil-main":{
      registryId:"KRG1",
      registryProcessedRevision:"drive-version:930",
      snapshotStatus:"PUBLISHED_CURRENT",
      manifestByFileId:{}
    }
  }};
  assert.equal(ctx.clearAcknowledged_(state,plan),1);
  assert.equal(state.dirty["gil-main"],undefined);
});


test("quiet period uses latest source modification, not first detection",async()=>{
  const ctx=await observerContext();
  const dirty={
    firstSeenAt:0,
    lastDispatchAt:null,
    lastDispatchSignature:"",
    files:{
      A:{observedRevision:"drive-version:1",sourceModifiedAtMs:2*60*1000,lastSeenAt:15*60*1000},
      B:{observedRevision:"drive-version:2",sourceModifiedAtMs:12*60*1000,lastSeenAt:15*60*1000}
    },
    reasons:{SOURCE_CHANGED:true}
  };
  const at15=ctx.dispatchEligibility_(dirty,15*60*1000,10*60*1000,45*60*1000);
  assert.equal(at15.ready,false);
  assert.equal(at15.reason,"WAITING_QUIET");
  const at30=ctx.dispatchEligibility_(dirty,30*60*1000,10*60*1000,45*60*1000);
  assert.equal(at30.ready,true);
  assert.equal(at30.reason,"READY");
});

test("new revision moves quiet-period anchor forward",async()=>{
  const ctx=await observerContext();
  const state={dirty:{}};
  ctx.markDirty_(state,"gil-main","TEST","SOURCE_CHANGED",15*60*1000,"drive-version:24","2026-09-27T16:00:00-03:00");
  const first=state.dirty["gil-main"].files.TEST.sourceModifiedAtMs;
  ctx.markDirty_(state,"gil-main","TEST","SOURCE_CHANGED",30*60*1000,"drive-version:25","2026-09-27T16:22:00-03:00");
  const second=state.dirty["gil-main"].files.TEST.sourceModifiedAtMs;
  assert.ok(second>first);
  const eligibility=ctx.dispatchEligibility_(
    state.dirty["gil-main"],
    Date.parse("2026-09-27T16:30:00-03:00"),
    10*60*1000,
    45*60*1000
  );
  assert.equal(eligibility.ready,false);
  assert.equal(eligibility.reason,"WAITING_QUIET");
});

test("same dispatched revision set waits for ACK before redispatch timeout",async()=>{
  const ctx=await observerContext();
  const dirty={
    firstSeenAt:0,
    lastDispatchAt:30*60*1000,
    lastDispatchSignature:"TEST@drive-version:24",
    files:{
      TEST:{observedRevision:"drive-version:24",sourceModifiedAtMs:10*60*1000,lastSeenAt:15*60*1000}
    },
    reasons:{SOURCE_CHANGED:true}
  };
  const at45=ctx.dispatchEligibility_(dirty,45*60*1000,10*60*1000,45*60*1000);
  assert.equal(at45.ready,false);
  assert.equal(at45.reason,"WAITING_ACK");
  const at76=ctx.dispatchEligibility_(dirty,76*60*1000,10*60*1000,45*60*1000);
  assert.equal(at76.ready,true);
  assert.equal(at76.reason,"RETRY_TIMEOUT");
});

test("different revision signature can dispatch after its own quiet period",async()=>{
  const ctx=await observerContext();
  const dirty={
    firstSeenAt:0,
    lastDispatchAt:30*60*1000,
    lastDispatchSignature:"TEST@drive-version:24",
    files:{
      TEST:{observedRevision:"drive-version:25",sourceModifiedAtMs:32*60*1000,lastSeenAt:35*60*1000}
    },
    reasons:{SOURCE_CHANGED:true}
  };
  const eligibility=ctx.dispatchEligibility_(dirty,45*60*1000,10*60*1000,45*60*1000);
  assert.equal(eligibility.ready,true);
  assert.equal(eligibility.reason,"READY");
});
