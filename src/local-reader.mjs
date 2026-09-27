import { DatabaseSync } from "node:sqlite";
import { assertReaderCompatible, READER_CONTRACT } from "./reader-contract.mjs";

const MATERIAL_GRAMMARS=new Set(["PE","BF","CX","SI","AR","BP","MT","RG","LU","IT","RC","RT","CP","CI","CA","EV"]);
const STOP=new Set(["a","o","as","os","um","uma","uns","umas","de","da","do","das","dos","e","ou","em","no","na","nos","nas","por","para","pra","pro","com","sem","que","se","ao","aos","pode","podemos","fazer","ir"]);

function norm(value){
  return String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}
function rawWords(value){
  return String(value??"").split(/[^A-Za-zÀ-ÖØ-öø-ÿ0-9]+/u).filter(Boolean);
}
function uniq(values){return [...new Set((values??[]).map(x=>String(x).trim()).filter(Boolean))];}
function boundaryContains(haystack,phrase){
  if(!phrase)return false;
  return (" "+haystack+" ").includes(" "+phrase+" ");
}
function personSegment(identity){
  if(identity.grammar!=="PE")return null;
  const raw=String(identity.matter??"").trim().split("/")[0].trim();
  const parts=raw.split(/\s+/).filter(Boolean).filter(p=>!/^(de|da|do|dos|das|e)$/i.test(p));
  if(!parts.length||parts.length>4)return null;
  return raw;
}
function identityAliases(identity){
  const values=[];
  for(const raw of [identity.matter,identity.external_name]){
    const n=norm(raw); if(n)values.push(n);
    for(const part of String(raw??"").split("/")){
      const p=norm(part); if(p&&p.length>=3)values.push(p);
    }
  }
  const seg=personSegment(identity);
  if(seg){
    const s=norm(seg); values.push(s);
    for(const token of s.split(/\s+/))if(token.length>=4)values.push(token);
  }
  return uniq(values);
}
function directScore(identity,candidate,candidateNorm){
  let score=0; const signals=[];
  const code=String(identity.stable_ref??"").trim();
  if(code){
    const escaped=code.replace(/[.*+?^$()|[\]\\]/g,"\\$&");
    if(new RegExp("(^|[^A-Za-z0-9])"+escaped+"([^A-Za-z0-9]|$)","i").test(candidate)){
      score+=120;signals.push("stable_ref_explicit");
    }
  }
  for(const alias of identityAliases(identity)){
    if(!boundaryContains(candidateNorm,alias))continue;
    const words=alias.split(/\s+/).filter(Boolean);
    const weight=words.length>=2?85:(identity.grammar==="PE"?42:35);
    score=Math.max(score,weight);
    signals.push(words.length>=2?"identity_phrase":"identity_token");
  }
  return {score,signals:uniq(signals)};
}
function candidateTerms(candidate){
  const out=[];
  for(const word of rawWords(candidate)){
    const n=norm(word);
    if(n.length<3||STOP.has(n))continue;
    out.push({raw:word,norm:n,capitalized:/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/u.test(word),uppercase:word.length>=2&&word===word.toUpperCase()});
  }
  const seen=new Set();
  return out.filter(x=>!seen.has(x.norm)&&seen.add(x.norm));
}
function ftsOr(terms){
  const safe=uniq(terms.map(t=>typeof t==="string"?norm(t):t.norm).flatMap(x=>x.split(/\s+/)))
    .filter(t=>/^[a-z0-9]+$/.test(t)&&t.length>=3);
  return safe.map(t=>'"'+t+'"').join(" OR ");
}
function codeRefs(text){
  return [...new Set([...String(text??"").matchAll(/\b(?:L|H\d|A|G)[A-Z]{1,4}\d{1,5}(?=_|\b)/g)].map(m=>m[0]))];
}
function queryTerms(query){
  const stop=new Set(["por","que","qual","quais","como","quando","onde","uma","um","uns","umas","o","a","os","as","de","da","do","das","dos","e","ou","em","no","na","nos","nas","para","pra","com","sem","bem","ser","esta","estao"]);
  return uniq(norm(query).split(/\s+/).filter(t=>t.length>=3&&!stop.has(t))).slice(0,24);
}
function capitalizedTargets(query){
  const stop=new Set(["Por","Que","Qual","Quais","Como","Quando","Onde","Todas","Todos","Uma","Um","O","A","Os","As","De","Da","Do","Das","Dos","Em","No","Na","Nos","Nas","E","Ou"]);
  return uniq(rawWords(query).filter(w=>/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/u.test(w)&&!stop.has(w)&&w.length>=3));
}
function semanticExpansionTerms(query){
  const q=norm(query);const out=[];
  if(/\bvo[a-z]*\b|\bvoo\b/.test(q))out.push("voo","voar","capacidade","mecanismo");
  if(/\bcarreg[a-z]*\b|\bcarga\b/.test(q))out.push("carregar","carga","massa","forca","peso","transportar","sustentacao","corpo","equilibrio");
  if(/\bressusc[a-z]*\b|\breviver\b/.test(q))out.push("ressuscitar","reviver","condicao","estado","temporal","transformacao","guardiao");
  if(/\btransform[a-z]*\b/.test(q))out.push("transformacao","estado","condicao","dominio","imaginacao");
  if(/\bveloc[a-z]*\b/.test(q))out.push("velocidade","movimento","aceleracao","forca","energia");
  return uniq(out);
}
function inferRoles(query){
  const q=norm(query);const roles=new Set(["support"]);
  if(/veloc|voo|voar|aerea|terrestre|massa|forca|peso|pressao|temperatura|aceler|movimento|impacto|gravidade|fisic|corpo|respir|vacuo|atmosfera/.test(q))roles.add("physical");
  if(/mecanismo|sistema|poder|capacidade|transform|divine|canal|controle|manifestacao|cria|criacao/.test(q))roles.add("mechanism");
  if(/antes|depois|apos|durante|quando|data|ano|mes|dia|cronolog|temporal|fase|periodo|201[0-9]|202[0-9]|203[0-9]/.test(q))roles.add("temporal");
  if(/lua|terra|espaco|cidade|lugar|distancia|geograf|planeta|ambiente/.test(q))roles.add("spatial");
  if(/condic|requer|depende|somente|apenas|limite|trava|pode|permite|permitir/.test(q))roles.add("condition");
  if(/nunca|jamais|proib|incompat|imposs|bloque|impede|nao pode|nao e|nao tem|nao possui/.test(q))roles.add("counterevidence");
  return [...roles];
}
function inferPurpose(roles){
  if(roles.includes("physical")&&roles.includes("mechanism"))return "physical_mechanism";
  if(roles.includes("physical"))return "physical";
  if(roles.includes("spatial"))return "spatial";
  if(roles.includes("temporal"))return "temporal";
  if(roles.includes("mechanism"))return "mechanism";
  return "context";
}
function isNarrativeIntent(query){
  const q=norm(query);
  return /\b(?:capitulo|chapter)\s+\d{1,3}\b/.test(q)||/\bh\d+rt\d{3}\b/.test(q);
}
function isFastIdentityLookup(query){
  const q=String(query??"").trim(),n=norm(q);
  if(/^[A-Za-z0-9]+$/.test(q)&&/^(?:L|H\d|A|G|K|Y)[A-Z]{1,4}\d{1,5}$/i.test(q))return true;
  const terms=queryTerms(q);
  if(terms.length>2)return false;
  return !/\b(pode|podemos|porque|por que|como|quando|onde|carregar|voar|ressuscitar|transformar|mudar|permitir|conhecer|desenvolver|preparar)\b/.test(n);
}
function compactIdentity(row){
  if(!row)return null;
  return {stable_ref:row.stable_ref,matter:row.matter,external_name:row.external_name,grammar:row.grammar,state:row.state,authority:row.authority,live_location:row.live_location};
}
function historyRoot(ref){const m=String(ref??"").match(/^(H\d+)/);return m?m[1]:null;}
function ordinalFromRef(ref,grammar){const m=String(ref??"").match(new RegExp("^H\\d+"+grammar+"(\\d{3})$"));return m?Number(m[1]):null;}

export class LocalStructuredReader{
  constructor(dbPath){
    this.dbPath=dbPath;
    this.capabilities=assertReaderCompatible(dbPath);
    this.db=new DatabaseSync(dbPath,{readOnly:true});
  }
  close(){this.db.close();}
  identities(){
    return this.db.prepare(`
      SELECT i.stable_ref,i.matter,i.external_name,i.grammar,i.state,i.authority,i.live_location
      FROM v2_identity_index i
      JOIN corpus_registry r ON r.sosl_code=i.stable_ref
       AND r.desired_presence='PRESENT' AND r.body_present=1
      WHERE i.active=1 ORDER BY i.stable_ref
    `).all();
  }
  resolveSeeds(candidate,maxSeeds=8){
    const identities=this.identities(),n=norm(candidate),scored=[];
    const tokenOwners=new Map();
    for(const identity of identities){
      const seg=personSegment(identity);if(!seg)continue;
      for(const token of new Set(norm(seg).split(/\s+/).filter(t=>t.length>=4))){
        if(!tokenOwners.has(token))tokenOwners.set(token,new Set());
        tokenOwners.get(token).add(identity.stable_ref);
      }
    }
    for(const identity of identities){
      let {score,signals}=directScore(identity,candidate,n);
      const seg=personSegment(identity);
      if(seg){
        for(const token of norm(seg).split(/\s+/).filter(t=>t.length>=4)){
          if((tokenOwners.get(token)?.size??0)!==1||!boundaryContains(n,token))continue;
          const cap=rawWords(candidate).some(w=>norm(w)===token&&/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/u.test(w));
          const extra=cap?38:28;
          if(score<extra){score=extra;signals.push(cap?"unique_person_token_cap:"+token:"unique_person_token:"+token);}
        }
      }
      if(score<25)continue;
      scored.push({stable_ref:identity.stable_ref,matter:identity.matter,grammar:identity.grammar,score,signals:uniq(signals),state:identity.state,authority:identity.authority,live_location:identity.live_location});
    }
    return scored.sort((a,b)=>b.score-a.score||a.stable_ref.localeCompare(b.stable_ref)).slice(0,Math.max(1,Math.min(maxSeeds,12)));
  }
  resolveNarrative(query){
    const identities=this.identities();
    const explicit=String(query).match(/\bH\d+RT\d{3}\b/i)?.[0]?.toUpperCase()??null;
    let target=null,ordinal=null,root=null,basis=null,pre=false,planned=null;
    if(explicit){
      target=identities.find(i=>i.stable_ref===explicit&&i.grammar==="RT")??null;
      if(!target)return {ok:false,error:"roteiro_explicito_nao_resolvido"};
      ordinal=ordinalFromRef(target.stable_ref,"RT");root=historyRoot(target.stable_ref);basis="explicit_rt_in_candidate";
    }else{
      const n=norm(query),m=n.match(/\b(?:capitulo|chapter)\s+(\d{1,3})\b/);
      if(!m)return {ok:false,error:"ordinal_narrativo_nao_resolvido"};
      ordinal=Number(m[1]);
      const after=n.slice((m.index??0)+m[0].length).trim();
      const stop=new Set(["a","o","as","os","de","da","do","das","dos","e","em","na","no","nas","nos","historia","saga","serie","story"]);
      const hints=after.split(/\s+/).filter(t=>t.length>=2&&!stop.has(t));
      const scores=new Map();
      for(const i of identities){
        if(!new Set(["MT","DR"]).has(i.grammar))continue;
        const r=historyRoot(i.stable_ref);if(!r||r==="H0")continue;
        const hay=" "+norm((i.matter??"")+" "+(i.external_name??""))+" ";
        if(hints.length&&hints.every(t=>hay.includes(" "+t+" ")))scores.set(r,Math.max(scores.get(r)??0,hints.length));
      }
      const roots=[...scores.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
      const candidates=identities.filter(i=>i.grammar==="RT"&&ordinalFromRef(i.stable_ref,"RT")===ordinal);
      if(roots.length){
        const best=roots[0][1],bestRoots=roots.filter(x=>x[1]===best).map(x=>x[0]);
        const matches=candidates.filter(i=>bestRoots.includes(historyRoot(i.stable_ref)));
        if(matches.length===1){target=matches[0];root=historyRoot(target.stable_ref);basis="story_hint_plus_ordinal";}
        else if(!matches.length&&bestRoots.length===1){root=bestRoots[0];pre=true;planned=root+"RT"+String(ordinal).padStart(3,"0");basis="story_hint_plus_ordinal_pre_rt";}
      }
      if(!root&&candidates.length===1){target=candidates[0];root=historyRoot(target.stable_ref);basis="unique_rt_for_ordinal";}
      if(!root)return {ok:false,error:"historia_nao_resolvida_para_ordinal"};
    }
    const priorCp=identities.filter(i=>i.grammar==="CP"&&historyRoot(i.stable_ref)===root)
      .map(row=>({row,ordinal:ordinalFromRef(row.stable_ref,"CP")})).filter(x=>Number.isInteger(x.ordinal)&&x.ordinal<ordinal).sort((a,b)=>a.ordinal-b.ordinal);
    const priorRt=identities.filter(i=>i.grammar==="RT"&&historyRoot(i.stable_ref)===root)
      .map(row=>({row,ordinal:ordinalFromRef(row.stable_ref,"RT")})).filter(x=>Number.isInteger(x.ordinal)&&x.ordinal<ordinal).sort((a,b)=>a.ordinal-b.ordinal);
    const currentCp=identities.find(i=>i.grammar==="CP"&&historyRoot(i.stable_ref)===root&&ordinalFromRef(i.stable_ref,"CP")===ordinal)??null;
    const macroMt=identities.find(i=>i.stable_ref===root+"MT00")??null;
    const prior=priorRt.at(-1)??null, gap=prior?ordinal-prior.ordinal:ordinal, contiguous=Boolean(pre&&prior&&gap===1);
    const refBasis=target?.stable_ref??(contiguous?prior?.row?.stable_ref:null);
    let refs=[];
    if(refBasis){
      refs=this.db.prepare(`
        SELECT l.object_ref,COUNT(*) AS evidence_count,
               GROUP_CONCAT(DISTINCT l.relation_class) AS relation_classes
        FROM v2_condition_links l
        JOIN corpus_registry r ON r.sosl_code=l.object_ref
          AND r.desired_presence='PRESENT' AND r.body_present=1
        WHERE l.active=1 AND l.provenance_content_ref LIKE ?
        GROUP BY l.object_ref ORDER BY evidence_count DESC,l.object_ref LIMIT 200
      `).all(refBasis+":%");
    }
    const byRef=new Map(identities.map(i=>[i.stable_ref,i]));
    const explicitRefs=refs.map(r=>({...r,identity:byRef.get(r.object_ref)})).filter(x=>x.identity)
      .map(x=>({...compactIdentity(x.identity),evidence_count:x.evidence_count,relation_classes:x.relation_classes}));
    const group=g=>explicitRefs.filter(x=>x.grammar===g);
    const material=explicitRefs.filter(x=>!new Set(["RT","CP","MT","DR","QE","CI"]).has(x.grammar));
    return {
      ok:true,readonly:true,resolver_version:"narrative_context_local_v1",
      selectors:{
        target_rt:compactIdentity(target),planned_rt_selector:pre?{stable_ref:planned,grammar:"RT",exists:false}:null,
        current_cp:compactIdentity(currentCp),prior_cp_corpus:priorCp.map(x=>({ordinal:x.ordinal,...compactIdentity(x.row)})),
        immediate_prior_cp:priorCp.length?{ordinal:priorCp.at(-1).ordinal,...compactIdentity(priorCp.at(-1).row)}:null,
        immediate_prior_rt:(!pre||contiguous)&&prior?{ordinal:prior.ordinal,...compactIdentity(prior.row)}:null,
        nearest_prior_rt:prior?{ordinal:prior.ordinal,...compactIdentity(prior.row)}:null,
        macro_mt:compactIdentity(macroMt),explicit_temporal_refs:group("MT"),
        explicit_direction_refs:group("DR"),explicit_sync_state_refs:group("QE"),explicit_material_refs:material,
        reference_basis:refBasis?{stable_ref:refBasis,mode:target?"target_rt":"immediate_prior_rt"}:null,
        sequence_state:{target_materialized:Boolean(target),planned_selector_only:pre,planned_rt_ref:planned,immediate_prior_rt_materialized:Boolean(prior),immediate_prior_rt_ref:prior?.row?.stable_ref??null,ordinal_gap_from_prior:gap,contiguous_with_nearest_materialized_rt:pre?gap===1:null,sequence_discontinuity:pre?gap>1:null,advisory_only:true}
      },
      orchestration:{inference_owner:"GIL",authority_role:"derived_advisory_surface_only",substantive_decision_claimed:false,requires_live_verification_when_material:true,resolution_basis:basis}
    };
  }
  specializedNeeds(query,targets){
    const q=norm(query),needs=[];
    if(/\bcarreg[a-z]*\b|\bcarga\b/.test(q))needs.push({id:"load_relation",targets,terms:["carga","massa","forca","peso","equilibrio","centro de massa","transportar","erguer","sustentacao","corpo","carregar"]});
    if(/\bvo[a-z]*\b|\bvoo\b/.test(q))needs.push({id:"flight_capability",targets:targets.slice(0,1),terms:["voo","voar","capacidade","sistema","corpo","mecanismo"]});
    if(/\bressusc[a-z]*\b|\breviver\b/.test(q))needs.push({id:"resurrection_condition",targets,terms:["ressuscitar","reviver","condicao","temporal","estado","transformacao","guardiao"]});
    if(/\btransform[a-z]*\b/.test(q))needs.push({id:"transformation_condition",targets,terms:["transformacao","cor","cabelo","dominio","imaginacao","projetado","maturacao","estado"]});
    if(/\bveloc[a-z]*\b/.test(q)&&!needs.length)needs.push({id:"speed_physics",targets,terms:["velocidade","movimento","aceleracao","forca","energia","terrestre","aerea","voo"]});
    return needs;
  }
  confrontation(query){
    const identities=this.identities(),byRef=new Map(identities.map(i=>[i.stable_ref,i]));
    const seeds=this.resolveSeeds(query,12),targets=capitalizedTargets(query);
    const needs=this.specializedNeeds(query,targets);
    const effective=needs.length?needs:[{id:"unified_primary_need",targets,terms:uniq([...queryTerms(query),...semanticExpansionTerms(query)])}];
    const sourceMap=new Map(),dependencyRefs=new Set();
    for(const need of effective){
      const targetTerms=uniq(need.targets.flatMap(x=>norm(x).split(/\s+/)).filter(t=>t.length>=3));
      const semanticTerms=uniq(need.terms.flatMap(x=>norm(x).split(/\s+/)).filter(t=>t.length>=3));
      let q="";
      if(targetTerms.length&&semanticTerms.length)q="("+ftsOr(targetTerms)+") AND ("+ftsOr(semanticTerms)+")";
      else q=ftsOr(targetTerms.length?targetTerms:semanticTerms);
      if(!q)continue;
      let rows=[];
      try{
        rows=this.db.prepare(`
          WITH base AS (
            SELECT rowid,bm25(v2_content_fts) AS rank FROM v2_content_fts
            WHERE v2_content_fts MATCH ? LIMIT 1800
          )
          SELECT c.content_pk,c.stable_ref,c.heading_path,c.content_text,c.provenance_locator,
                 s.sosl_code,s.title,s.source_class,i.grammar,b.rank
          FROM base b
          JOIN v2_content_units c ON c.content_pk=b.rowid AND c.active=1
          JOIN v2_source_objects s ON s.source_id=c.source_id AND s.active=1
          JOIN corpus_registry r ON r.sosl_code=s.sosl_code AND r.desired_presence='PRESENT' AND r.body_present=1
          LEFT JOIN v2_identity_index i ON i.stable_ref=s.sosl_code AND i.active=1
          ORDER BY rank,c.content_pk LIMIT 800
        `).all(q);
      }catch{rows=[];}
      for(const row of rows){
        const text=norm((row.heading_path??"")+" "+(row.content_text??"")+" "+(row.title??""));
        const targetHits=targetTerms.filter(t=>boundaryContains(text,t)).length;
        const semanticHits=semanticTerms.filter(t=>boundaryContains(text,t)).length;
        if(targetTerms.length&&targetHits===0&&semanticHits<2)continue;
        if(semanticHits===0)continue;
        if(!MATERIAL_GRAMMARS.has(String(row.grammar??"")))continue;
        const score=targetHits*40+semanticHits*18;
        const key=row.sosl_code;
        if(!sourceMap.has(key))sourceMap.set(key,{sosl_code:key,title:row.title,grammar:row.grammar,need_score:0,hits:0,evidence:[]});
        const s=sourceMap.get(key);s.need_score=Math.max(s.need_score,score);s.hits++;
        if(s.evidence.length<3)s.evidence.push({ref:row.stable_ref,heading:row.heading_path??null,text:String(row.content_text??"").slice(0,500),provenance:row.provenance_locator??null,retrieval_origin:"typed_need",need_id:need.id});
        for(const ref of codeRefs((row.heading_path??"")+" "+(row.content_text??"")))dependencyRefs.add(ref);
      }
    }
    const dependencies=[...dependencyRefs].filter(r=>byRef.has(r)&&!seeds.some(s=>s.stable_ref===r)).map(r=>compactIdentity(byRef.get(r))).slice(0,24);
    const seedRefs=seeds.map(s=>s.stable_ref);
    let graph=[];
    if(seedRefs.length){
      const ph=seedRefs.map(()=>"?").join(",");
      graph=this.db.prepare(`
        SELECT relation_id,subject_ref,predicate,object_ref,relation_class,provenance_content_ref,provenance_locator,state
        FROM v2_condition_links WHERE active=1 AND relation_class='krg1_registered_relation'
        AND (subject_ref IN (${ph}) OR object_ref IN (${ph}))
        ORDER BY relation_id LIMIT 80
      `).all(...seedRefs,...seedRefs);
    }
    const sources=[...sourceMap.values()].sort((a,b)=>b.need_score-a.need_score||b.hits-a.hits||a.sosl_code.localeCompare(b.sosl_code)).slice(0,16);
    let status="context_sufficient_for_interpretation";
    if(!seeds.length&&!sources.length&&!dependencies.length)status="incomplete_corpus_gap";
    const qn=norm(query);
    if(/\b(todas|todos|cada|qualquer)\b/.test(qn)&&/\b(regra|regras|condicoes|itens|casos)\b/.test(qn))status="incomplete_coverage";
    const seedText=seeds.map(s=>norm(s.stable_ref+" "+s.matter)).join(" ");
    const unmatched=targets.filter(t=>!seedText.includes(norm(t)));
    if(unmatched.length&&/\b(lua|terra|planeta|espaco|cidade|pais|estado|oceano|continente|lugar)\b/.test(qn))status="incomplete_external_reference";
    return {status,seeds,sources,dependencies,graph_links:graph,needs};
  }
  resolveContext(query){
    query=String(query??"").trim();
    if(!query)throw new Error("query_ausente");
    if(query.length>4000)throw new Error("query_excede_4000_chars");
    const started=Date.now();
    if(isNarrativeIntent(query)){
      const n=this.resolveNarrative(query);
      if(!n.ok)return {ok:false,readonly:true,resolver_version:READER_CONTRACT,context_status:"technical_failure",error:n.error};
      return {ok:true,readonly:true,resolver_version:READER_CONTRACT,query,intent:{kind:"narrative",adaptive_route:"narrative_context"},context_status:"context_sufficient_for_interpretation",package:{selectors:n.selectors,orchestration:n.orchestration},verification:{live_required_when_material:true,reason:"derived_discovery_not_material_authority"},telemetry:{consumer_calls:1,total_duration_ms:Date.now()-started,rows_written:0}};
    }
    if(isFastIdentityLookup(query)){
      const seeds=this.resolveSeeds(query,8);
      return {ok:true,readonly:true,resolver_version:READER_CONTRACT,query,intent:{kind:"identity_fast_path"},context_status:seeds.length?"context_sufficient_for_interpretation":"incomplete_corpus_gap",package:{seeds,sources:[],dependencies:[],graph_links:[],unresolved_terms:[],baseline:null},verification:{live_required_when_material:true,live_pointers:seeds.filter(x=>x.live_location).map(x=>({stable_ref:x.stable_ref,live_location:x.live_location,authority:x.authority??null})),broad_drive_search_authorized:false},contract:{discovery_and_recovery:"structured_bank_reader",live_sources:"verification_only_when_material_or_proven_gap",internal_resolvers_hidden_from_consumer:true,insufficient_first_pass_does_not_authorize_drive_fallback:true},telemetry:{consumer_calls:1,total_duration_ms:Date.now()-started,rows_written:0}};
    }
    const c=this.confrontation(query);
    return {ok:true,readonly:true,resolver_version:READER_CONTRACT,query,intent:{kind:"adaptive_confrontation",inferred_needs:c.needs},context_status:c.status,package:{seeds:c.seeds,sources:c.sources,dependencies:c.dependencies,graph_links:c.graph_links,unresolved_terms:[],baseline:null},verification:{live_required_when_material:true,live_pointers:uniq([...c.seeds,...c.dependencies].filter(x=>x.live_location).map(x=>JSON.stringify({stable_ref:x.stable_ref,live_location:x.live_location,authority:x.authority??null}))).map(JSON.parse),broad_drive_search_authorized:false},contract:{discovery_and_recovery:"structured_bank_reader",live_sources:"verification_only_when_material_or_proven_gap",internal_resolvers_hidden_from_consumer:true,insufficient_first_pass_does_not_authorize_drive_fallback:true},telemetry:{consumer_calls:1,total_duration_ms:Date.now()-started,rows_written:0}};
  }
}

export function openLocalReader(dbPath){return new LocalStructuredReader(dbPath);}
