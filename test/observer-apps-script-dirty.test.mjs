import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function observerContext() {
  const source=await readFile(new URL("../apps-script/observer-v0.2.0/Code.gs",import.meta.url),"utf8");
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
