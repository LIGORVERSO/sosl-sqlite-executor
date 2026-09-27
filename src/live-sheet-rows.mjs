import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function quoteSheet(title) {
  return "'" + String(title).replaceAll("'", "''") + "'";
}

function normalizeCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

export function serializeSheetRow(values) {
  const cells = Array.from(values ?? [], normalizeCell);
  while (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells.join("\t");
}

export function compileSheetRowUnits({soslCode, driveFileId, tabs}) {
  const code = String(soslCode ?? "").trim();
  if (!code || !driveFileId) throw new Error("sheet source missing identity");
  const units = [{
    stable_ref: code,
    unit_type: "spreadsheet_root",
    position_ordinal: 0,
    sheet_title: null,
    row_number: null,
    content_text: code,
    content_hash: sha256(code),
    provenance_locator: "drive:" + driveFileId
  }];
  let ordinal = 1;
  for (const tab of tabs ?? []) {
    const title = String(tab?.title ?? "").trim();
    if (!title) throw new Error(code + ": sheet without title");
    for (const row of tab.rows ?? []) {
      const content = serializeSheetRow(row.values ?? []);
      if (!content) continue;
      const rowNumber = Number(row.row_number);
      if (!Number.isInteger(rowNumber) || rowNumber < 1) {
        throw new Error(code + "/" + title + ": invalid row_number");
      }
      units.push({
        stable_ref: code + ":sheet:" + title + ":row:" + String(rowNumber).padStart(6,"0"),
        unit_type: "spreadsheet_row",
        position_ordinal: ordinal++,
        sheet_title: title,
        row_number: rowNumber,
        content_text: content,
        content_hash: sha256(content),
        provenance_locator: "drive:" + driveFileId + ";sheet:" + title + ";row:" + rowNumber
      });
    }
  }
  return units;
}

export async function fetchGoogleSheetRows({source, accessToken, fetchImpl=fetch}) {
  const fileId = String(source?.drive_file_id ?? "").trim();
  const code = String(source?.sosl_code ?? "").trim();
  if (!fileId || !code) throw new Error("incomplete Sheets source");
  const headers = {authorization:"Bearer " + accessToken};

  const metaUrl =
    "https://sheets.googleapis.com/v4/spreadsheets/" +
    encodeURIComponent(fileId) +
    "?fields=properties(title),sheets(properties(sheetId,title,index))";
  const metaResponse = await fetchImpl(metaUrl,{headers});
  const meta = await metaResponse.json().catch(()=>({}));
  if (!metaResponse.ok) throw new Error(code + ": Sheets metadata failed");

  const titles = (meta.sheets ?? [])
    .map(s=>({title:String(s?.properties?.title ?? ""),index:Number(s?.properties?.index ?? 0)}))
    .filter(s=>s.title)
    .sort((a,b)=>a.index-b.index);

  if (!titles.length) throw new Error(code + ": spreadsheet without tabs");

  const tabs=[];
  for (const sheet of titles) {
    const url =
      "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(fileId) + "/values/" +
      encodeURIComponent(quoteSheet(sheet.title)) +
      "?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING";
    const response = await fetchImpl(url,{headers});
    const payload = await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(code + "/" + sheet.title + ": readonly Sheets read failed");
    const rows=[];
    for (let i=0;i<(payload.values ?? []).length;i++) {
      const values=payload.values[i] ?? [];
      if (values.every(v=>normalizeCell(v)==="")) continue;
      rows.push({row_number:i+1,values});
    }
    tabs.push({title:sheet.title,rows});
  }

  const units=compileSheetRowUnits({soslCode:code,driveFileId:fileId,tabs});
  const bodyHash=sha256(JSON.stringify(units.slice(1).map(u=>[u.stable_ref,u.content_hash])));

  return {
    sosl_code:code,
    drive_file_id:fileId,
    title:String(meta?.properties?.title ?? source.title ?? code),
    tabs,
    units,
    body_hash:bodyHash,
    nonempty_rows:units.length-1
  };
}
