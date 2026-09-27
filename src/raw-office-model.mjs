import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { buildV1CompatibleParagraphModel } from "./v1-compatible-doc-model.mjs";
import { compileSheetRowUnits } from "./live-sheet-rows.mjs";

function h(value) {
  return createHash("sha256").update(String(value),"utf8").digest("hex");
}
function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"')
    .replace(/&apos;/g,"'").replace(/&amp;/g,"&")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function paragraphStyle(xml) {
  const match=xml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"[^>]*\/?\s*>/i);
  const raw=match?.[1] ?? "";
  const heading=raw.match(/^Heading\s*([1-9])$/i);
  if (heading) return "HEADING_"+heading[1];
  if (/^Title$/i.test(raw)) return "TITLE";
  if (/^Subtitle$/i.test(raw)) return "SUBTITLE";
  return raw || "NORMAL_TEXT";
}
function paragraphText(xml) {
  const tokenPattern=/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?\s*>|<w:br\b[^>]*\/?\s*>/gi;
  let out="";
  for (const match of xml.matchAll(tokenPattern)) {
    if (match[1]!==undefined) out+=decodeXml(match[1]);
    else if (/^<w:tab/i.test(match[0])) out+="\t";
    else out+="\n";
  }
  return out.trim();
}
export function parseRawDocxModel(bytes,soslCode) {
  const files=unzipSync(new Uint8Array(bytes));
  const documentBytes=files["word/document.xml"];
  if (!documentBytes) throw new Error("DOCX without word/document.xml");
  const xml=strFromU8(documentBytes);
  const paragraphs=[];
  let ordinal=0;
  for (const match of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi)) {
    const block=match[0], text=paragraphText(block);
    if (!text) continue;
    ordinal++;
    paragraphs.push({text,style:paragraphStyle(block),startIndex:ordinal,endIndex:ordinal});
  }
  const model=buildV1CompatibleParagraphModel(paragraphs,soslCode);
  const units=model.items.map(item=>({
    stable_ref:item.stable_ref,
    unit_type:item.kind,
    position_ordinal:item.ordinal+1,
    heading_path:item.section,
    content_text:item.text,
    content_hash:item.content_hash,
    provenance_locator:"docx:"+soslCode+";paragraph:"+(item.ordinal+1)
  }));
  return {kind:"docx",units,semantic_hash:model.hash};
}
export function parseRawXlsxModel(bytes,soslCode) {
  const workbook=XLSX.read(Buffer.from(bytes),{type:"buffer",cellDates:false,cellText:true,raw:false});
  const tabs=[];
  for (const title of workbook.SheetNames) {
    const sheet=workbook.Sheets[title];
    const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:"",raw:false,blankrows:true});
    const normalized=[];
    for (let i=0;i<rows.length;i++) {
      const values=Array.from(rows[i] ?? [],v=>v==null?"":String(v));
      if (values.every(v=>v.trim()==="")) continue;
      normalized.push({row_number:i+1,values});
    }
    tabs.push({title,rows:normalized});
  }
  const all=compileSheetRowUnits({soslCode,driveFileId:"raw-seed:"+soslCode,tabs});
  const units=all.slice(1).map(unit=>({...unit,provenance_locator:"xlsx:"+soslCode+";sheet:"+unit.sheet_title+";row:"+unit.row_number}));
  return {kind:"xlsx",units,semantic_hash:h(JSON.stringify(units.map(u=>[u.stable_ref,u.content_hash])))};
}
