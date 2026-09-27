import { createHash } from "node:crypto";
import { observeStyledDocumentWithToken } from "./structured-doc-source.mjs";
import { buildV1CompatibleParagraphModel } from "./v1-compatible-doc-model.mjs";
import { fetchGoogleSheetRows } from "./live-sheet-rows.mjs";
import { acquireRawOfficeSource } from "./live-office-source.mjs";
import { parseRawDocxModel, parseRawXlsxModel } from "./raw-office-model.mjs";

const GDOC="application/vnd.google-apps.document";
const GSHEET="application/vnd.google-apps.spreadsheet";
const DOCX="application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function sha256(value) {
  return createHash("sha256").update(String(value),"utf8").digest("hex");
}
function normalizeLiteral(value) {
  return String(value ?? "").split(/\s+/u).filter(Boolean).join(" ").trim();
}
function revisionForVersion(version) {
  return "drive-version:" + String(version);
}

async function driveMeta(source,accessToken,fetchImpl=fetch) {
  const url=
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(source.drive_file_id) +
    "?fields=id,name,mimeType,version,modifiedTime,trashed&supportsAllDrives=true";
  const r=await fetchImpl(url,{headers:{authorization:"Bearer "+accessToken}});
  const body=await r.json().catch(()=>({}));
  if (!r.ok || body.id!==source.drive_file_id || body.trashed===true || !body.version) {
    throw new Error(source.sosl_code + ": invalid Drive metadata");
  }
  return body;
}

export function normalizeDesiredUnits({
  source,
  observedRevision,
  metadataText,
  units
}) {
  const out=[];
  let ordinal=0;
  const add=unit=>{
    if (unit.unit_type==="spreadsheet_root") return;
    const text=normalizeLiteral(unit.content_text ?? unit.text);
    if (!text) return;
    const stableRef=String(unit.stable_ref ?? "").trim();
    if (!stableRef) throw new Error(source.sosl_code + ": empty stable_ref");
    const contentHash=String(unit.content_hash ?? sha256(text));
    out.push({
      stable_ref:stableRef,
      unit_type:unit.unit_type ?? unit.kind ?? "atom",
      position_ordinal:ordinal++,
      heading_path:unit.heading_path ?? unit.section ?? null,
      content_text:text,
      content_hash:contentHash,
      provenance_locator:
        unit.provenance_locator ??
        ("drive:"+source.drive_file_id+";ref:"+stableRef)
    });
  };

  if (metadataText) {
    add({
      stable_ref:source.sosl_code+":@source",
      unit_type:"source_metadata",
      content_text:metadataText,
      provenance_locator:"drive:"+source.drive_file_id+";source-metadata"
    });
  }

  for (const unit of units ?? []) add(unit);
  return out;
}

export async function acquireLiveSourceModel({
  source,
  accessToken,
  fetchImpl=fetch
}) {
  const before=await driveMeta(source,accessToken,fetchImpl);
  const observedRevision=revisionForVersion(before.version);
  let sourceHash;
  let units;

  if (before.mimeType===GDOC) {
    const observed=await observeStyledDocumentWithToken({
      source,
      accessToken,
      fetchImpl
    });
    if (revisionForVersion(observed.version)!==observedRevision) {
      throw new Error(source.sosl_code + ": revision changed during Google Doc read");
    }
    const model=buildV1CompatibleParagraphModel(observed.paragraphs,source.sosl_code);
    sourceHash=model.hash;
    units=model.items.map(item=>({
      stable_ref:item.stable_ref,
      unit_type:item.kind,
      position_ordinal:item.ordinal+1,
      heading_path:item.section,
      content_text:item.text,
      content_hash:item.content_hash,
      provenance_locator:
        "drive:"+source.drive_file_id+
        ";start:"+(item.startIndex ?? "")+
        ";end:"+(item.endIndex ?? "")
    }));
  } else if (before.mimeType===GSHEET) {
    const body=await fetchGoogleSheetRows({source,accessToken,fetchImpl});
    const after=await driveMeta(source,accessToken,fetchImpl);
    if (revisionForVersion(after.version)!==observedRevision) {
      throw new Error(source.sosl_code + ": revision changed during Sheet read");
    }
    sourceHash=body.body_hash;
    units=body.units;
  } else if (before.mimeType===DOCX || before.mimeType===XLSX) {
    const raw=await acquireRawOfficeSource({source,accessToken,fetchImpl});
    if (revisionForVersion(raw.version)!==observedRevision) {
      throw new Error(source.sosl_code + ": revision changed during Office read");
    }
    const model=before.mimeType===DOCX
      ? parseRawDocxModel(raw.bytes,source.sosl_code)
      : parseRawXlsxModel(raw.bytes,source.sosl_code);
    sourceHash=model.semantic_hash;
    units=model.units;
  } else {
    throw new Error(source.sosl_code + ": unsupported mime " + before.mimeType);
  }

  return {
    sosl_code:source.sosl_code,
    drive_file_id:source.drive_file_id,
    mime_type:before.mimeType,
    title:before.name || source.title || source.sosl_code,
    observed_revision:observedRevision,
    source_hash:sourceHash,
    units
  };
}
