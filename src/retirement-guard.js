export const RETIREMENT_HOLD_MS = 2 * 60 * 1000;
export const RETIREMENT_PREFIX = "ARQ_";

export function retirementDueAt(armedAt){
  const value=Number(armedAt);
  if(!Number.isFinite(value)||value<=0)throw new Error("RETIREMENT_ARMED_AT_INVALID");
  return value+RETIREMENT_HOLD_MS;
}

export function expectedRetirementName(externalName){
  const name=String(externalName??"").trim();
  if(!name||name.startsWith(RETIREMENT_PREFIX))throw new Error("RETIREMENT_EXTERNAL_NAME_INVALID");
  return RETIREMENT_PREFIX+name;
}

export function canArmRetirement({
  desiredPresence,state,registrySeenAt,physicalEventAt,preexistingPrefix=false,watchCovered=true
}){
  const r=Number(registrySeenAt), p=Number(physicalEventAt);
  if(desiredPresence!=="ABSENT"||state!=="INACTIVE")return false;
  if(!Number.isFinite(r)||!Number.isFinite(p)||p<=r)return false;
  if(preexistingPrefix===true||watchCovered!==true)return false;
  return true;
}

export function retirementStillValid({
  desiredPresence,state,driveIdMatches=true,prefixMatches=true,watchCovered=true
}){
  return desiredPresence==="ABSENT"&&state==="INACTIVE"&&driveIdMatches===true&&prefixMatches===true&&watchCovered===true;
}

export function retirementReady({
  now,dueAt,desiredPresence,state,driveIdMatches=true,prefixMatches=true,watchCovered=true
}){
  const n=Number(now), d=Number(dueAt);
  if(!Number.isFinite(n)||!Number.isFinite(d)||n<d)return false;
  return retirementStillValid({desiredPresence,state,driveIdMatches,prefixMatches,watchCovered});
}
