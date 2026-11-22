const http = require('http');

const PORT = process.env.PORT || 3000;

let state = {
  updatedAt: new Date().toISOString(),
  sessionSignals: [],
  demoPositionsByPair: {}
};

function refreshState() {
  state = {
    updatedAt: new Date().toISOString(),
    sessionSignals: state.sessionSignals,
    demoPositionsByPair: state.demoPositionsByPair
  };
}

setInterval(refreshState, 5000);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (req.method === 'GET' && urlPath === '/api/signals') {
    refreshState();
    return sendJson(res, 200, state);
  }

  if (req.method === 'POST' && urlPath === '/api/signals') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        state = {
          updatedAt: new Date().toISOString(),
          sessionSignals: Array.isArray(parsed.sessionSignals)
            ? parsed.sessionSignals
            : state.sessionSignals,
          demoPositionsByPair:
            parsed.demoPositionsByPair && typeof parsed.demoPositionsByPair === 'object'
              ? parsed.demoPositionsByPair
              : state.demoPositionsByPair
        };
        return sendJson(res, 200, { ok: true, state });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
      }
    });
    return;
  }

  if (req.method === 'GET' && urlPath === '/') {
    return sendJson(res, 200, {
      status: 'running',
      service: 'crypto-pro-24x7-backend',
      endpoints: ['/api/signals']
    });
  }

  return sendJson(res, 404, { error: 'Not Found' });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
