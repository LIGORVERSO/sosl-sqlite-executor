export function shouldAcknowledgeSourceDirty({
  observedRevision,
  manifestDriveRevision,
  processedRevision,
  syncStatus
}) {
  const expected=String(observedRevision??"").trim();
  if (!expected || expected==="REMOVED") return false;
  if (String(manifestDriveRevision??"")!==expected) return false;
  if (String(processedRevision??"")!==expected) return false;
  if (/DIRTY|ERROR|PENDING/i.test(String(syncStatus??""))) return false;
  return true;
}
