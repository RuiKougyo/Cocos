// Apps Script の実行環境をローカル（Node.js）で再現する最小限のモック。
// 本番では使わない。gas/Code.gs をそのまま読み込んでテスト・画面の動作確認に使う。
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const toSigned = (buf) => [...buf].map((b) => (b > 127 ? b - 256 : b));
const toBuf = (v) => (Array.isArray(v) ? Buffer.from(v.map((b) => b & 0xff)) : Buffer.from(String(v), 'utf8'));

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  setNumberFormat() { return this; }
  setValues(values) {
    values.forEach((row, i) => row.forEach((v, j) => this.sheet.set(this.r + i, this.c + j, v)));
    return this;
  }
  clearContent() {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.set(this.r + i, this.c + j, '');
    return this;
  }
  getValues() { return this.sheet.grid.slice(0, this.sheet.getLastRow()).map((r) => [...r]); }
}

class Sheet {
  constructor(name) { this.name = name; this.grid = []; }
  set(r, c, v) {
    while (this.grid.length < r) this.grid.push([]);
    // 先頭の ' は「文字列として扱う」印なので保存時に外す（スプレッドシートと同じ）
    this.grid[r - 1][c - 1] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
  }
  getMaxRows() { return 1000; }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  getLastRow() {
    for (let i = this.grid.length; i > 0; i--) if ((this.grid[i - 1] ?? []).some((v) => v !== '' && v != null)) return i;
    return 0;
  }
  getDataRange() {
    const width = Math.max(0, ...this.grid.map((r) => r.length));
    const sheet = this;
    return { getValues: () => sheet.grid.slice(0, sheet.getLastRow()).map((r) => Array.from({ length: width }, (_, j) => r[j] ?? '')) };
  }
  appendRow(values) { const r = this.getLastRow() + 1; values.forEach((v, j) => this.set(r, j + 1, v)); }
  deleteRow(r) { this.grid.splice(r - 1, 1); }
  setFrozenRows() {}
}

export function createGas(codePath = new URL('../Code.gs', import.meta.url)) {
  const sheets = new Map();
  const props = new Map();
  const logs = [];
  const spreadsheet = {
    getSheetByName: (n) => sheets.get(n) ?? null,
    insertSheet: (n) => { const s = new Sheet(n); sheets.set(n, s); return s; },
  };
  const triggerBuilder = { timeBased: () => triggerBuilder, everyDays: () => triggerBuilder, atHour: () => triggerBuilder, create: () => ({}) };
  const context = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
        deleteProperty: (k) => { props.delete(k); },
      }),
    },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => triggerBuilder },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Logger: { log: (s) => logs.push(String(s)) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      MacAlgorithm: { HMAC_SHA_1: 'sha1' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => randomUUID(),
      computeDigest: (alg, value) => toSigned(createHash(alg).update(toBuf(value)).digest()),
      computeHmacSignature: (alg, value, key) => toSigned(createHmac(alg, toBuf(key)).update(toBuf(value)).digest()),
      formatDate: (date, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(codePath, 'utf8'), context, { filename: 'Code.gs' });

  return {
    ctx: context,
    logs,
    props,
    sheets,
    /** ウェブアプリへの POST と同じ経路で呼び出す */
    post(body) {
      const out = context.doPost({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(out.getContent());
    },
  };
}
