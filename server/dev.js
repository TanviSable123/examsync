import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function freePort(){return new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const p=probe.address().port;probe.close(error=>error?reject(error):resolve(p))})})}
const port=Number(process.env.PORT || await freePort());
process.env.EXAMSYNC_NO_LISTEN='1';

// Run the API handler and Vite UI behind the same HTTP listener. This avoids
// stale proxy ports and guarantees that browser /api requests reach this API.
const { server: api }=await import('./index.js');
const httpServer=http.createServer((req,res)=>{
  if((req.url||'').split('?')[0].startsWith('/api/')) return api.emit('request',req,res);
  vite.middlewares(req,res);
});
const vite=await createViteServer({
  configFile:path.join(root,'vite.config.js'),
  server:{middlewareMode:true,hmr:{server:httpServer},allowedHosts:true}
});
httpServer.listen(port,'0.0.0.0',()=>{
  console.log(`Open ExamSync at http://localhost:${port}/`);
  console.log(`API health check: http://localhost:${port}/api/health`);
  console.log('Persistent app data: MongoDB (database examsync, collection app_state)');
});
let stopping=false;
async function stop(code=0){
  if(stopping)return; stopping=true;
  httpServer.close(); await vite.close(); process.exitCode=code;
}
process.on('SIGINT',()=>stop(0));
process.on('SIGTERM',()=>stop(0));
