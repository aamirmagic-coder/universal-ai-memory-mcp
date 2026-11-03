import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://claude.ai",
  "https://claude.com",
  "https://cursor.com",
  "https://www.cursor.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);
const SUPPORTED_PROTOCOLS = new Set(["2025-03-26", "2025-06-18", "2025-11-25"]);
const TOOL_DEFS = [
  { name: "memory_search", description: "Search durable memory before relying on prior decisions or project context. Results are restricted to the authenticated owner's permitted workspace.", inputSchema: { type:"object", properties:{ query:{type:"string",maxLength:500}, workspace:{type:"string",maxLength:64}, limit:{type:"integer",minimum:1,maximum:50} }, required:["query"], additionalProperties:false } },
  { name: "memory_save", description: "Save or update non-sensitive durable facts, project decisions, preferences and lessons. Use a stable external_id. Never save passwords, API keys, payment credentials, medical or other highly sensitive personal data, or third-party personal data.", inputSchema: { type:"object", properties:{ external_id:{type:"string",minLength:1,maxLength:200}, workspace:{type:"string",maxLength:64}, memory_type:{type:"string",enum:["fact","decision","lesson","event","goal","note","project","preference"]}, content:{type:"string",minLength:1,maxLength:20000}, tags:{type:"array",items:{type:"string",maxLength:80},maxItems:50}, metadata:{type:"object"}, importance:{type:"number",minimum:0,maximum:1}, confidence:{type:"number",minimum:0,maximum:1}, is_pinned:{type:"boolean"}, source_created_at:{type:"string"} }, required:["external_id","memory_type","content"], additionalProperties:false } },
  { name: "memory_archive", description: "Soft-archive a memory by stable external_id. Use only when the owner explicitly asks to remove or retire that memory. Permanent deletion is intentionally not exposed through this MCP interface.", inputSchema: { type:"object", properties:{ external_id:{type:"string",minLength:1,maxLength:200}, workspace:{type:"string",maxLength:64} }, required:["external_id"], additionalProperties:false } },
  { name: "memory_list", description: "List recent memory records in one permitted workspace, optionally filtered by type. Archived items are included for review.", inputSchema: { type:"object", properties:{ workspace:{type:"string",maxLength:64}, memory_type:{type:"string",enum:["fact","decision","lesson","event","goal","note","project","preference"]}, limit:{type:"integer",minimum:1,maximum:100} }, additionalProperties:false } },
  { name: "memory_stats", description: "Return counts of stored, active, archived and pinned memory records in a permitted workspace.", inputSchema: { type:"object", properties:{ workspace:{type:"string",maxLength:64} }, additionalProperties:false } }
];

function json(data: unknown, status=200, origin?: string) {
  const headers: Record<string,string> = {
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store",
    "x-content-type-options":"nosniff"
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["access-control-allow-origin"]=origin;
    headers["vary"]="Origin";
    headers["access-control-allow-headers"]="authorization, content-type, mcp-protocol-version";
    headers["access-control-allow-methods"]="POST, OPTIONS";
  }
  return new Response(JSON.stringify(data), {status,headers});
}
async function readJsonLimited(req:Request,maxBytes=65536):Promise<any> {
  if(!req.body) throw new Error("Invalid JSON");
  const reader=req.body.getReader();
  const chunks:Uint8Array[]=[];
  let total=0;
  while(true) {
    const {done,value}=await reader.read();
    if(done) break;
    total+=value.byteLength;
    if(total>maxBytes) {
      await reader.cancel();
      throw new RangeError("Request too large");
    }
    chunks.push(value);
  }
  const bytes=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function rpcResponse(id: unknown,result: unknown) { return {jsonrpc:"2.0",id,result}; }
function rpcError(id: unknown,code:number,message:string) { return {jsonrpc:"2.0",id,error:{code,message}}; }
function toolResult(value:unknown,isError=false) {
  return {content:[{type:"text",text:typeof value==="string"?value:JSON.stringify(value)}],isError};
}
async function sha256Hex(value:string) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
}
async function callDb(name:string,payload:Record<string,unknown>) {
  const url=Deno.env.get("SUPABASE_URL");
  const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key) throw new Error("Storage is not configured");
  const response=await fetch(new URL("/rest/v1/rpc/"+name,url),{
    method:"POST",
    headers:{"content-type":"application/json","apikey":key,"authorization":"Bearer "+key},
    body:JSON.stringify(payload)
  });
  const result=await response.json().catch(()=>null);
  if(!response.ok) {
    console.error("Memory database operation failed",name,response.status);
    throw new Error("Memory operation failed");
  }
  return result;
}
function validWorkspace(value:unknown): value is string {
  return typeof value==="string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
}
Deno.serve(async(req:Request)=>{
  const origin=req.headers.get("origin")||undefined;
  if(origin && !ALLOWED_ORIGINS.has(origin)) return json({error:"Origin not allowed"},403);
  if(req.method==="OPTIONS") return new Response(null,{status:204,headers:origin?{
    "access-control-allow-origin":origin,
    "access-control-allow-headers":"authorization, content-type, mcp-protocol-version",
    "access-control-allow-methods":"POST, OPTIONS",
    "vary":"Origin"
  }:{}});
  if(req.method==="GET" || req.method==="DELETE") return new Response(null,{status:405,headers:{"allow":"POST, OPTIONS"}});
  if(req.method!=="POST") return json({error:"Method not allowed"},405,origin);
  const accept=req.headers.get("accept")||"";
  if(!accept.includes("application/json") || !accept.includes("text/event-stream")) return json({error:"Accept must include application/json and text/event-stream"},406,origin);
  const contentType=req.headers.get("content-type")||"";
  if(!contentType.toLowerCase().includes("application/json")) return json({error:"Content-Type must be application/json"},415,origin);
  const protocol=req.headers.get("mcp-protocol-version");
  if(protocol && !SUPPORTED_PROTOCOLS.has(protocol)) return json({error:"Unsupported MCP protocol version",supported:Array.from(SUPPORTED_PROTOCOLS)},400,origin);
  const auth=req.headers.get("authorization")||"";
  const token=auth.startsWith("Bearer ")?auth.slice(7):"";
  if(!token || token.length>256) return json({error:"Unauthorized"},401,origin);
  const tokenHash=await sha256Hex(token);
  let clientRows:any;
  try { clientRows=await callDb("resolve_memory_client",{p_token_hash:tokenHash}); }
  catch { return json({error:"Memory authentication unavailable"},503,origin); }
  const client=Array.isArray(clientRows)?clientRows[0]:null;
  if(!client) return json({error:"Unauthorized"},401,origin);
  let body:any;
  try { body=await readJsonLimited(req,65536); }
  catch(error) {
    if(error instanceof RangeError) return json({error:"Request too large"},413,origin);
    return json({error:"Invalid JSON"},400,origin);
  }
  const id=body?.id;
  const method=body?.method;
  if(body?.jsonrpc!=="2.0" || typeof method!=="string") return json(rpcError(id,-32600,"Invalid JSON-RPC request"),400,origin);
  if(method.startsWith("notifications/")) return new Response(null,{status:202});
  if(method==="ping") return json(rpcResponse(id,{}),200,origin);
  if(method==="initialize") {
    const requested=body.params?.protocolVersion;
    const version=typeof requested==="string" && SUPPORTED_PROTOCOLS.has(requested)?requested:"2025-11-25";
    return json(rpcResponse(id,{
      protocolVersion:version,
      capabilities:{tools:{listChanged:false}},
      serverInfo:{name:"universal-ai-memory",version:"1.0.0"},
      instructions:"Owner-controlled shared memory. Search before relying on prior decisions. Save only durable, non-sensitive information. Separate project workspaces. Never store credentials, payment data, medical details, or sensitive personal information. Archive only on explicit owner request."
    }),200,origin);
  }
  if(method==="tools/list") return json(rpcResponse(id,{tools:TOOL_DEFS}),200,origin);
  if(method!=="tools/call") return json(rpcError(id,-32601,"Method not found"),404,origin);
  const name=body.params?.name;
  const args=body.params?.arguments||{};
  const tool=TOOL_DEFS.find(t=>t.name===name);
  if(!tool) return json(rpcResponse(id,toolResult("Unknown memory tool",true)),200,origin);
  if(!Array.isArray(client.permissions)||!client.permissions.includes(name)) return json(rpcResponse(id,toolResult("Client is not authorised for this operation",true)),200,origin);
  const workspace=args.workspace===undefined?"personal":args.workspace;
  if(!validWorkspace(workspace)) return json(rpcResponse(id,toolResult("Invalid workspace identifier",true)),200,origin);
  const allowed=Array.isArray(client.allowed_workspaces)?client.allowed_workspaces:[];
  if(!allowed.includes("*")&&!allowed.includes(workspace)) return json(rpcResponse(id,toolResult("Client is not authorised for this workspace",true)),200,origin);
  try {
    let result:unknown;
    let externalId:string|null=null;
    if(name==="memory_search") {
      if(typeof args.query!=="string"||args.query.length>500) return json(rpcResponse(id,toolResult("query must be a string of at most 500 characters",true)),200,origin);
      result=await callDb("search_memory_records",{p_owner_id:client.owner_id,p_workspace_id:workspace,p_query:args.query,p_limit:Number.isInteger(args.limit)?args.limit:10});
    } else if(name==="memory_save") {
      if(typeof args.external_id!=="string"||args.external_id.length<1||args.external_id.length>200||typeof args.content!=="string"||typeof args.memory_type!=="string") return json(rpcResponse(id,toolResult("external_id, memory_type and content are required",true)),200,origin);
      externalId=args.external_id;
      const metadata=args.metadata&&typeof args.metadata==="object"&&!Array.isArray(args.metadata)?args.metadata:{};
      if(JSON.stringify(metadata).length>8192) return json(rpcResponse(id,toolResult("metadata is too large",true)),200,origin);
      result=await callDb("sync_memory_record",{
        p_owner_id:client.owner_id,p_external_id:args.external_id,p_workspace_id:workspace,p_memory_type:args.memory_type,
        p_content:args.content,p_tags:Array.isArray(args.tags)?args.tags.slice(0,50).filter((x:unknown)=>typeof x==="string").map((x:string)=>x.slice(0,80)):[],
        p_metadata:metadata,p_importance:Number.isFinite(args.importance)?args.importance:0.5,
        p_confidence:Number.isFinite(args.confidence)?args.confidence:1,p_is_pinned:args.is_pinned===true,
        p_source_created_at:typeof args.source_created_at==="string"?args.source_created_at:null
      });
    } else if(name==="memory_archive") {
      if(typeof args.external_id!=="string"||args.external_id.length>200) return json(rpcResponse(id,toolResult("external_id is required",true)),200,origin);
      externalId=args.external_id;
      result=await callDb("archive_memory_record",{p_owner_id:client.owner_id,p_external_id:args.external_id,p_workspace_id:workspace});
    } else if(name==="memory_list") {
      result=await callDb("list_memory_records",{p_owner_id:client.owner_id,p_workspace_id:workspace,p_memory_type:typeof args.memory_type==="string"?args.memory_type:null,p_limit:Number.isInteger(args.limit)?args.limit:50});
    } else {
      result=await callDb("get_memory_stats",{p_owner_id:client.owner_id,p_workspace_id:workspace});
    }
    await callDb("record_memory_access",{p_client_id:client.id,p_owner_id:client.owner_id,p_action:name,p_workspace_id:workspace,p_external_id:externalId,p_metadata:{transport:"mcp"}});
    return json(rpcResponse(id,toolResult(result)),200,origin);
  } catch {
    return json(rpcResponse(id,toolResult("Memory service temporarily unavailable",true)),200,origin);
  }
});