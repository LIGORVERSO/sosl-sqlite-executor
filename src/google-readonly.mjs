import { createSign } from "node:crypto";

function b64url(value) {
  return Buffer.from(value).toString("base64url");
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
  const response=await fetchImpl("https://oauth2.googleapis.com/token",{
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const body=await response.json().catch(()=>({}));
  if (!response.ok || !body.access_token) throw new Error("Google token failed");
  return body.access_token;
}

export async function readSheetValues(spreadsheetId,range,accessToken,fetchImpl=fetch) {
  const url=
    "https://sheets.googleapis.com/v4/spreadsheets/"+
    encodeURIComponent(spreadsheetId)+"/values/"+encodeURIComponent(range)+
    "?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE";
  const response=await fetchImpl(url,{headers:{authorization:"Bearer "+accessToken}});
  const body=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error("Sheets read failed: "+response.status);
  return body.values??[];
}

export async function driveFileMeta(fileId,accessToken,fetchImpl=fetch) {
  const url=
    "https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(fileId)+
    "?fields=id,name,mimeType,version,modifiedTime,trashed&supportsAllDrives=true";
  const response=await fetchImpl(url,{headers:{authorization:"Bearer "+accessToken}});
  const body=await response.json().catch(()=>({}));
  if (!response.ok || body.id!==fileId || body.trashed===true || !body.version) {
    throw new Error("Drive metadata invalid for "+fileId);
  }
  return body;
}
