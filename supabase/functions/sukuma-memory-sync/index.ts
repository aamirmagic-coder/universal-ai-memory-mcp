import "jsr:@supabase/functions-js/edge-runtime.d.ts";

async function hash(value:string) {
 const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
 return Array.from(new Uint8Array(d),b=>b.toString(16).padStart(2,"0")).join("");
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
 if(Number(req.headers.get("content-length")||"0")>65536) return out({error:"Request too large"},413);
 const bearer=req.headers.get("authorization")||"", token=bearer.startsWith("Bearer ")?bearer.slice(7):"";
 if(!token||token.length>256) return out({error:"Unauthorized"},401);
 let body:any; try{body=await req.json()}catch{return out({error:"Invalid JSON"},400)}
 const op=body?.operation;
 if(op!=="upsert"&&op!=="delete") return out({error:"Unsupported operation"},400);
 try {
  const rows=await rpc("resolve_memory_client",{p_token_hash:await hash(token)});
  const client=Array.isArray(rows)?rows[0]:null;
  if(!client) return out({error:"Unauthorized"},401);
  const workspace=typeof body.workspace_id==="string"&&body.workspace_id.trim()?body.workspace_id.trim():"sukuma";
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(workspace)) return out({error:"Invalid workspace"},400);
  const allowed=Array.isArray(client.allowed_workspaces)?client.allowed_workspaces:[];
  if(!allowed.includes("*")&&!allowed.includes(workspace)) return out({error:"Workspace not authorised"},403);
  let result;
  if(op==="upsert") {
   if(!client.permissions?.includes("memory_save")) return out({error:"Operation not authorised"},403);
   if(typeof body.external_id!=="string"||typeof body.content!=="string"||body.content.length<1||body.content.length>20000) return out({error:"Invalid memory content or ID"},400);
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