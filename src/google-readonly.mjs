import { createSign } from "node:crypto";

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

const TRANSIENT_HTTP=new Set([408,425,429,500,502,503,504]);

function sleep(ms){
  return new Promise(resolve=>setTimeout(resolve,ms));
}

export async function googleFetchWithRetry(url,options={},fetchImpl=fetch,{
  attempts=4,
  baseDelayMs=250
}={}) {
  let lastError=null;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{
      const response=await fetchImpl(url,options);
      if(!TRANSIENT_HTTP.has(Number(response.status)) || attempt===attempts){
        return response;
      }
      lastError=new Error("Google transient HTTP "+response.status);
    }catch(error){
      lastError=error;
      if(attempt===attempts) throw error;
    }
    await sleep(baseDelayMs*Math.pow(2,attempt-1));
  }
  throw lastError??new Error("Google request failed");
}

export async function googleAccessTokenFromServiceAccountJson(raw,scopes,fetchImpl=fetch) {
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing");
  const credential=JSON.parse(raw);
  const now=Math.floor(Date.now()/1000);
  const header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claims=b64url(JSON.stringify({
    iss:credential.client_email,
    scope:scopes.join(" "),
    aud:"https://oauth2.googleapis.com/token",
    iat:now,
    exp:now+3600
  }));
  const unsigned=header+"."+claims;
  const signer=createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion=unsigned+"."+signer.sign(credential.private_key).toString("base64url");
  const response=await googleFetchWithRetry("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  },fetchImpl);
  const body=await response.json().catch(()=>({}));
  if (!response.ok || !body.access_token) throw new Error("Google token failed");
  return body.access_token;
}

export async function readSheetValues(spreadsheetId,range,accessToken,fetchImpl=fetch) {
  const url=
    "https://sheets.googleapis.com/v4/spreadsheets/"+
    encodeURIComponent(spreadsheetId)+"/values/"+encodeURIComponent(range)+
    "?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE";
  const response=await googleFetchWithRetry(
    url,
    {headers:{authorization:"Bearer "+accessToken}},
    fetchImpl
  );
  const body=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error("Sheets read failed: "+response.status);
  return body.values??[];
}

export async function driveFileMeta(fileId,accessToken,fetchImpl=fetch) {
  const url=
    "https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(fileId)+
    "?fields=id,name,mimeType,version,modifiedTime,trashed&supportsAllDrives=true";
  const response=await googleFetchWithRetry(
    url,
    {headers:{authorization:"Bearer "+accessToken}},
    fetchImpl
  );
  const body=await response.json().catch(()=>({}));
  if (!response.ok || body.id!==fileId || body.trashed===true || !body.version) {
    throw new Error("Drive metadata invalid for "+fileId);
  }
  return body;
}
