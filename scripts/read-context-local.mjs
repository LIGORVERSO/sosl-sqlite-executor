import { openLocalReader } from "../src/local-reader.mjs";

function args(argv){
  const out={};
  for(let i=2;i<argv.length;i++){
    const item=argv[i];
    if(item==="--db") out.db=argv[++i];
    else if(item==="--query") out.query=argv[++i];
  }
  return out;
}
const parsed=args(process.argv);
const dbPath=String(parsed.db||process.env.SOSL_SQLITE_PATH||"").trim();
const query=String(parsed.query||process.env.SOSL_READER_QUERY||"").trim();
if(!dbPath) throw new Error("Reader requires --db or SOSL_SQLITE_PATH");
if(!query) throw new Error("Reader requires --query or SOSL_READER_QUERY");

const reader=openLocalReader(dbPath);
try{
  process.stdout.write(JSON.stringify(reader.resolveContext(query))+"\n");
}finally{
  reader.close();
}
