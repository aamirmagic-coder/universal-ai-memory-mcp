import "jsr:@supabase/functions-js/edge-runtime.d.ts";

async function hash(value:string) {
 const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
 return Array.from(new Uint8Array(d),b=>b.toString(16).padStart(2,"0")).join("");
}
async function readJsonLimited(req:Request,maxBytes=65536):Promise<any> {
 const reader=req.body?.getReader();
 if(!reader) throw new Error("Invalid JSON");
 const chunks:Uint8Array[]=[]; let total=0;
 while(true) {
  const {done,value}=await reader.read(); if(done) break;
  total+=value.byteLength;
  if(total>maxBytes) { await reader.cancel(); throw new RangeError("Request too large"); }
  chunks.push(value);
 }
 const bytes=new Uint8Array(total); let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
function out(data:unknown,status=200) {
 return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
}
async function rpc(name:string,payload:Record<string,unknown>) {
 const url=Deno.env.get("SUPABASE_URL"), key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!key) throw new Error("Storage not configured");
 const res=await fetch(new URL("/rest/v1/rpc/"+name,url),{method:"POST",headers:{"content-type":"application/json","apikey":key,"authorization":"Bearer "+key},body:JSON.stringify(payload)});
 const data=await res.json().catch(()=>null);
 if(!res.ok) throw new Error("RPC failed");
 return data;
}
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST") return out({error:"Method not allowed"},405);
 const bearer=req.headers.get("authorization")||"", token=bearer.startsWith("Bearer ")?bearer.slice(7):"";
 if(!token||token.length>256) return out({error:"Unauthorized"},401);
 let body:any;
 try{body=await readJsonLimited(req,65536)}
 catch(error){if(error instanceof RangeError)return out({error:"Request too large"},413);return out({error:"Invalid JSON"},400)}
 const op=body?.operation;
 if(op!=="upsert"&&op!=="delete"&&op!=="upsert_batch") return out({error:"Unsupported operation"},400);
 try {
  const rows=await rpc("resolve_memory_client",{p_token_hash:await hash(token)});
  const client=Array.isArray(rows)?rows[0]:null;
  if(!client) return out({error:"Unauthorized"},401);
  const workspace=typeof body.workspace_id==="string"&&body.workspace_id.trim()?body.workspace_id.trim():"sukuma";
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(workspace)) return out({error:"Invalid workspace"},400);
  const allowed=Array.isArray(client.allowed_workspaces)?client.allowed_workspaces:[];
  if(!allowed.includes("*")&&!allowed.includes(workspace)) return out({error:"Workspace not authorised"},403);
  if(op==="upsert_batch") {
   if(!client.permissions?.includes("memory_save")) return out({error:"Operation not authorised"},403);
   const records=body.records;
   if(!Array.isArray(records)||records.length<1||records.length>50) return out({error:"records must contain 1-50 items"},400);
   for(const item of records) {
    if(!item||typeof item.external_id!=="string"||item.external_id.length<1||item.external_id.length>200||
       typeof item.content!=="string"||item.content.length<1||item.content.length>20000||
       !["fact","decision","lesson","event","goal","note","project","preference"].includes(item.memory_type||"note")) {
      return out({error:"Batch contains an invalid record"},400);
    }
    if(item.metadata&&JSON.stringify(item.metadata).length>8192) return out({error:"Record metadata too large"},400);
   }
   const results=[];
   for(const item of records) {
    const result=await rpc("sync_memory_record",{
     p_owner_id:client.owner_id,p_external_id:item.external_id,p_workspace_id:workspace,
     p_memory_type:item.memory_type||"note",p_content:item.content,
     p_tags:Array.isArray(item.tags)?item.tags.slice(0,50).filter((x:unknown)=>typeof x==="string").map((x:string)=>x.slice(0,80)):[],
     p_metadata:item.metadata&&typeof item.metadata==="object"&&!Array.isArray(item.metadata)?item.metadata:{},
     p_importance:Number.isFinite(item.importance)?item.importance:0.5,
     p_confidence:Number.isFinite(item.confidence)?item.confidence:1,
     p_is_pinned:item.is_pinned===true,
     p_source_created_at:typeof item.source_created_at==="string"?item.source_created_at:null
    });
    await rpc("record_memory_access",{p_client_id:client.id,p_owner_id:client.owner_id,p_action:"sync_upsert",p_workspace_id:workspace,p_external_id:item.external_id,p_metadata:{transport:"pmb-batch-sync"}});
    results.push({external_id:item.external_id,ok:true,id:result?.id||null});
   }
   return out({ok:true,operation:op,processed:results.length,results});
  }
  let result;
  if(op==="upsert") {
   if(!client.permissions?.includes("memory_save")) return out({error:"Operation not authorised"},403);
   if(typeof body.external_id!=="string"||body.external_id.length<1||body.external_id.length>200||typeof body.content!=="string"||body.content.length<1||body.content.length>20000) return out({error:"Invalid memory content or ID"},400);
   const kind=["fact","decision","lesson","event","goal","note","project","preference"].includes(body.memory_type)?body.memory_type:"note";
   result=await rpc("sync_memory_record",{
    p_owner_id:client.owner_id,p_external_id:body.external_id,p_workspace_id:workspace,p_memory_type:kind,p_content:body.content,
    p_tags:Array.isArray(body.tags)?body.tags.slice(0,50).filter((x:unknown)=>typeof x==="string").map((x:string)=>x.slice(0,80)):[],
    p_metadata:body.metadata&&typeof body.metadata==="object"&&!Array.isArray(body.metadata)?body.metadata:{},
    p_importance:Number.isFinite(body.importance)?body.importance:0.5,p_confidence:Number.isFinite(body.confidence)?body.confidence:1,
    p_is_pinned:body.is_pinned===true,p_source_created_at:typeof body.source_created_at==="string"?body.source_created_at:null
   });
  } else {
   if(!client.permissions?.includes("memory_archive")) return out({error:"Operation not authorised"},403);
   if(typeof body.external_id!=="string"||!body.external_id) return out({error:"External ID required"},400);
   result=await rpc("archive_memory_record",{p_owner_id:client.owner_id,p_external_id:body.external_id,p_workspace_id:workspace});
  }
  await rpc("record_memory_access",{p_client_id:client.id,p_owner_id:client.owner_id,p_action:"sync_"+op,p_workspace_id:workspace,p_external_id:body.external_id||null,p_metadata:{transport:"legacy-rest-sync"}});
  return out({ok:true,operation:op,result});
 } catch { return out({error:"Memory service temporarily unavailable"},503); }
});