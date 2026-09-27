import { compileCorpusRegistryIntent } from "./corpus-registry.js";
import { readSheetValues, driveFileMeta } from "./google-readonly.mjs";

function sheetRows(values){
  if(!Array.isArray(values)||values.length<1) return [];
  const headers=(values[0]??[]).map(x=>String(x??"").trim());
  return values.slice(1).map((row,index)=>({
    row_number:index+2,
    cells:Object.fromEntries(headers.map((h,i)=>[h,row?.[i]??""]))
  }));
}

export async function loadLiveKrg1({spreadsheetId,accessToken}){
  const before=await driveFileMeta(spreadsheetId,accessToken);
  const [identityValues,provisionalValues,relationValues]=await Promise.all([
    readSheetValues(spreadsheetId,"IDENTIDADES!A1:T999",accessToken),
    readSheetValues(spreadsheetId,"SUPORTES_PROVISORIOS!A1:R999",accessToken),
    readSheetValues(spreadsheetId,"RELACOES!A1:G999",accessToken)
  ]);
  const after=await driveFileMeta(spreadsheetId,accessToken);
  if(String(before.version)!==String(after.version)){
    throw new Error("KRG1_CHANGED_DURING_STRUCTURED_READ");
  }
  const revision="drive-version:"+String(after.version);
  const identityTab={title:"IDENTIDADES",rows:sheetRows(identityValues)};
  const provisionalTab={title:"SUPORTES_PROVISORIOS",rows:sheetRows(provisionalValues)};
  const relationTab={title:"RELACOES",rows:sheetRows(relationValues)};
  const intent=compileCorpusRegistryIntent({
    sources:[{
      sosl_code:"KRG1",
      revision,
      tabs:[identityTab,provisionalTab,relationTab]
    }]
  });
  return {
    revision,
    metadata:after,
    identityTab,
    provisionalTab,
    relationTab,
    intent
  };
}
