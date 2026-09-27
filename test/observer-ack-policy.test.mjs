import test from "node:test";
import assert from "node:assert/strict";
import { shouldAcknowledgeSourceDirty } from "../src/observer-ack-policy.mjs";

test("stale manifest cannot clear dirty detected from newer Drive revision",()=>{
  assert.equal(shouldAcknowledgeSourceDirty({
    observedRevision:"drive-version:23",
    manifestDriveRevision:"drive-version:20",
    processedRevision:"drive-version:20",
    syncStatus:"registry_missing_fail_closed"
  }),false);
});

test("dirty clears only when manifest and processed revision both catch up",()=>{
  assert.equal(shouldAcknowledgeSourceDirty({
    observedRevision:"drive-version:23",
    manifestDriveRevision:"drive-version:23",
    processedRevision:"drive-version:23",
    syncStatus:"verified_live"
  }),true);
});

test("removed or pending states never auto-acknowledge",()=>{
  assert.equal(shouldAcknowledgeSourceDirty({
    observedRevision:"REMOVED",
    manifestDriveRevision:"drive-version:23",
    processedRevision:"drive-version:23",
    syncStatus:"verified_live"
  }),false);
  assert.equal(shouldAcknowledgeSourceDirty({
    observedRevision:"drive-version:23",
    manifestDriveRevision:"drive-version:23",
    processedRevision:"drive-version:23",
    syncStatus:"DIRTY_PENDING"
  }),false);
});
