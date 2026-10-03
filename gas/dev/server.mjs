// ローカル開発用: gas/Code.gs を Apps Script のウェブアプリと同じ形（POST に JSON を返す）で動かす。
//   node gas/dev/server.mjs [port]
//   → app/.env.local に VITE_BACKEND=gas と VITE_GAS_URL=http://localhost:8787/exec を設定して画面を起動
import { createServer } from 'node:http';
import { createGas } from './gas-runtime.mjs';

const port = Number(process.argv[2] ?? 8787);
const gas = createGas();
gas.ctx.initialize();

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/exec') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const out = gas.ctx.doPost({ postData: { contents: body } });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(out.getContent());
    });
    return;
  }
  // 開発用の補助情報（本番の Apps Script には存在しない）
  if (req.method === 'GET' && req.url === '/__dev') {
    return send(res, 200, { setup_code: gas.props.get('setup_code'), join_code: gas.props.get('join_code') });
  }
  send(res, 404, { ok: false });
}).listen(port, () => {
  console.log(`GAS dev server: http://localhost:${port}/exec`);
  console.log(`初期設定コード: ${gas.props.get('setup_code')}  店舗URLのコード: ${gas.props.get('join_code')}`);
});
