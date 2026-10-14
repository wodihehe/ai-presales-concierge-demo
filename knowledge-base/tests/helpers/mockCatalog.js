import http from 'node:http';

// Synthetic upstream only. Credentials are checked in memory and never logged.
export async function startMockCatalog() {
  let mode = 'normal';
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'slow') { res.writeHead(200); res.write('{"data":'); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/redirected' }); res.end(); return; }
    if (/^http\d+$/.test(mode)) { res.writeHead(Number(mode.slice(4))); res.end(JSON.stringify({error: req.headers.authorization})); return; }
    if (mode === 'invalid') { res.end('<html>SYNTHETIC_INVALID</html>'); return; }
    if (mode === 'shape') { res.end(JSON.stringify({ models: ['synthetic-chat'] })); return; }
    if (mode === 'large') { res.end(' '.repeat(2 * 1024 * 1024 + 1)); return; }
    if (mode === 'many') { res.end(JSON.stringify({data: Array.from({length:5001}, (_,i)=>({id:`synthetic-${i}`}))})); return; }
    if (mode === 'empty') { res.end('{"data":[]}'); return; }
    res.end(JSON.stringify({ data: [
      {id:'synthetic-chat-b', owned_by:'SYNTHETIC_PRIVATE_METADATA'},
      {id:'synthetic-chat-a'}, {id:'synthetic-chat-a'}, {id:' synthetic-vision '},
      {id:'synthetic-long-model-name-for-narrow-screen-layout-verification-2026-09-24'},
      {id:42}, {id:''}, {id: req.headers.authorization?.slice(7)}
    ] }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    setMode(next) { mode = next; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
