import { createHash } from "node:crypto";

const DOCX="application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function metadata(token, source, fetchImpl) {
  const url=
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(source.drive_file_id) +
    "?fields=id,name,mimeType,version,modifiedTime,trashed&supportsAllDrives=true";
  const response=await fetchImpl(url,{headers:{authorization:"Bearer "+token}});
  const body=await response.json().catch(()=>({}));
  if (!response.ok || body.id!==source.drive_file_id || body.trashed===true) {
    throw new Error(source.sosl_code + ": invalid Office metadata");
  }
  return body;
}

export async function acquireRawOfficeSource({source,accessToken,fetchImpl=fetch}) {
  const before=await metadata(accessToken,source,fetchImpl);
  if (![DOCX,XLSX].includes(before.mimeType)) {
    throw new Error(source.sosl_code + ": unsupported Office mime " + before.mimeType);
  }
  const url=
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(source.drive_file_id) +
    "?alt=media&supportsAllDrives=true";
  const response=await fetchImpl(url,{headers:{authorization:"Bearer "+accessToken}});
  if (!response.ok) throw new Error(source.sosl_code + ": Office download failed");
  const bytes=Buffer.from(await response.arrayBuffer());
  const after=await metadata(accessToken,source,fetchImpl);
  if (String(before.version)!==String(after.version) || before.modifiedTime!==after.modifiedTime) {
    throw new Error(source.sosl_code + ": revision changed during Office read");
  }
  return {
    sosl_code:source.sosl_code,
    drive_file_id:source.drive_file_id,
    mime_type:after.mimeType,
    version:String(after.version),
    modified_time:after.modifiedTime,
    title:after.name || source.title || source.sosl_code,
    sha256:sha256(bytes),
    bytes
  };
}
