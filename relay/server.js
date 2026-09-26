const http=require("http");
const crypto=require("crypto");
const clients=new Set();
const token=process.env.COPILOT_TOKEN||"";
let latest=null;
const uploads=new Map();
function auth(req){return !token||req.headers.authorization==="Bearer "+token}
const server=http.createServer((req,res)=>{
 if(!auth(req)){res.writeHead(401);return res.end("unauthorized")}
 if(req.url==="/health"){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({ok:true,clients:clients.size,uploads:uploads.size}))}
 if(req.url==="/state"){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify(latest||{}))}
 if(req.url==="/attachments"){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify([...uploads.values()]))}
 res.writeHead(404);res.end("not found");
});
server.on("upgrade",(req,socket)=>{
 if(req.url!=="/ws"||!auth(req)){socket.destroy();return}
 const key=req.headers["sec-websocket-key"];
 const accept=crypto.createHash("sha1").update(key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
 socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+"\r\n\r\n");
 socket._buf=Buffer.alloc(0);clients.add(socket);
 socket.on("data",buf=>{
  socket._buf=Buffer.concat([socket._buf,buf]);
  while(socket._buf.length>=2){
   const b1=socket._buf[0],b2=socket._buf[1],masked=!!(b2&128);let len=b2&127,off=2;
   if(len===126){if(socket._buf.length<4)return;len=socket._buf.readUInt16BE(2);off=4}
   else if(len===127){if(socket._buf.length<10)return;len=Number(socket._buf.readBigUInt64BE(2));off=10}
   if(masked)off+=4;if(socket._buf.length<off+len)return;
   const payload=Buffer.from(socket._buf.subarray(off,off+len));
   if(masked){const m=socket._buf.subarray(off-4,off);for(let i=0;i<payload.length;i++)payload[i]^=m[i%4]}
   socket._buf=socket._buf.subarray(off+len);
   if((b1&15)===8){clients.delete(socket);socket.end();return}
   if((b1&15)===1){try{
    const msg=JSON.parse(payload.toString());
    if(msg.type==="state")latest=msg;
    if(msg.type==="attachment_start")uploads.set(msg.id,{id:msg.id,name:msg.name,mime:msg.mime,size:msg.size,time:msg.time,chunks:0,complete:false});
    if(msg.type==="attachment_chunk"){const u=uploads.get(msg.id);if(u)u.chunks++}
    if(msg.type==="attachment_end"){const u=uploads.get(msg.id);if(u)u.complete=true}
    broadcast(msg,socket);
   }catch{}}
  }
 });
 socket.on("close",()=>clients.delete(socket));
});
function frame(obj){const p=Buffer.from(JSON.stringify(obj));if(p.length>=126&&p.length<65536){const h=Buffer.alloc(4);h[0]=129;h[1]=126;h.writeUInt16BE(p.length,2);return Buffer.concat([h,p])}if(p.length<126)return Buffer.concat([Buffer.from([129,p.length]),p]);throw new Error("frame too large")}
function broadcast(obj,except){let data;try{data=frame(obj)}catch{return}for(const c of clients)if(c!==except)c.write(data)}
setInterval(()=>broadcast({type:"heartbeat",time:Date.now()}),15000);
server.listen(process.env.PORT||8080,"0.0.0.0");
