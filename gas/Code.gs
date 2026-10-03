/**
 * シフト収集＆空き状況可視化システム — 無料版バックエンド（Google スプレッドシート + Apps Script）
 *
 * ・このファイルを店舗用スプレッドシートの「拡張機能 → Apps Script」に貼り付けて使う
 * ・ウェブアプリとして「実行ユーザー: 自分」「アクセス: 全員」でデプロイし、画面（app/）から JSON で呼び出す
 * ・個人情報は表示名のみ。PIN・パスワードはソルト付きハッシュで保存する
 * ・権限チェックはすべてこのファイルで行う（スタッフは自分の提出のみ、他人は名前と時間帯のみ閲覧可）
 * ・営業日は 06:00〜翌 02:00。時刻は「営業日 0:00 からの分」（360〜1560）で保存する
 *
 * 手順は docs/setup-free.md を参照。
 */

// ============================================================================
// 定数
// ============================================================================
var DAY_START = 360; // 06:00
var DAY_END = 1560; // 翌 02:00
var TZ = 'Asia/Tokyo';
var ADMIN_SESSION_DAYS = 14;
var MAX_PENDING = 20;

var TABLES = {
  members: ['id', 'display_name', 'status', 'pin_salt', 'pin_hash', 'token_hash', 'failed_pin_count',
    'locked_until', 'sort_order', 'created_at', 'approved_at', 'retired_at'],
  periods: ['id', 'label', 'start_date', 'end_date', 'deadline', 'status', 'view_start_min', 'view_end_min', 'created_at'],
  submissions: ['period_id', 'member_id', 'note', 'days_json', 'updated_at'],
  assignments: ['period_id', 'member_id', 'work_date', 'start_min', 'end_min', 'updated_at'],
  feedback: ['id', 'body', 'created_at'],
  audit_logs: ['at', 'actor', 'action', 'target'],
};

// ============================================================================
// 初期設定（Apps Script エディタから手動で実行する）
// ============================================================================

/** シートの作成、URL コードと設定コードの発行、毎日の自動削除トリガーの登録。何度実行しても安全。 */
function initialize() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABLES).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = TABLES[name];
    // 全セルを書式なしテキストにする（日付や数値への自動変換を防ぐ）
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
  });
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('join_code')) props.setProperty('join_code', newToken_().slice(0, 32));
  if (!props.getProperty('admin_hash') && !props.getProperty('setup_code')) {
    props.setProperty('setup_code', newSetupCode_());
  }
  var hasTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'purgeExpiredData';
  });
  if (!hasTrigger) ScriptApp.newTrigger('purgeExpiredData').timeBased().everyDays(1).atHour(3).create();

  var setup = props.getProperty('setup_code');
  Logger.log(setup
    ? '初期設定コード: ' + setup + '\n店長画面（#/admin）の「初期設定」でこのコードを入力してください。'
    : '初期設定は完了しています。');
}

/** 店長のパスワード・認証アプリを忘れたときに実行する。新しい初期設定コードが発行される。 */
function resetAdmin() {
  var props = PropertiesService.getScriptProperties();
  ['admin_salt', 'admin_hash', 'totp_secret', 'totp_last_counter', 'admin_sessions', 'admin_failed',
    'admin_locked_until', 'pending_admin'].forEach(function (k) { props.deleteProperty(k); });
  props.setProperty('setup_code', newSetupCode_());
  audit_('system', 'admin.reset', '');
  Logger.log('新しい初期設定コード: ' + props.getProperty('setup_code'));
}

// ============================================================================
// HTTP 入口
// ============================================================================
function doGet() {
  return json_({ ok: true, data: 'cocos shift api' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  try {
    return json_({ ok: true, data: dispatch_(req) });
  } catch (err) {
    var code = (err && err.code) || 'error';
    if (code === 'error') console.error(err && err.stack);
    return json_({ ok: false, error: code, message: code === 'error' ? 'server error' : String(err.message) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  var e = new Error(message || code);
  e.code = code;
  throw e;
}

/** action → [認証の種類, 書き込みか, 処理] */
var ROUTES = {
  // 誰でも（URL のコードで店舗を確認）
  store_info: ['none', false, apiStoreInfo_],
  register: ['none', true, apiRegister_],
  login: ['none', true, apiLogin_],
  // スタッフ（承認待ちでも可）
  me: ['staff_any', false, apiMe_],
  logout: ['staff_any', true, apiLogout_],
  // スタッフ（承認済みのみ）
  periods: ['staff', false, apiStaffPeriods_],
  my_submission: ['staff', false, apiMySubmission_],
  submit_shift: ['staff', true, apiSubmitShift_],
  submit_feedback: ['staff', true, apiSubmitFeedback_],
  board: ['staff', false, apiBoard_],
  // 店長の認証
  admin_status: ['none', false, apiAdminStatus_],
  admin_setup: ['none', true, apiAdminSetup_],
  admin_setup_verify: ['none', true, apiAdminSetupVerify_],
  admin_login: ['none', true, apiAdminLogin_],
  // 店長
  admin_me: ['admin', false, function () { return { store_name: prop_('store_name') || '' }; }],
  admin_logout: ['admin', true, apiAdminLogout_],
  admin_periods: ['admin', false, function () { return listPeriods_(false); }],
  create_period: ['admin', true, apiCreatePeriod_],
  set_period_status: ['admin', true, apiSetPeriodStatus_],
  delete_period: ['admin', true, apiDeletePeriod_],
  timeline: ['admin', false, apiTimeline_],
  set_assignment: ['admin', true, apiSetAssignment_],
  remove_assignment: ['admin', true, apiRemoveAssignment_],
  unsubmitted: ['admin', false, apiUnsubmitted_],
  feedback: ['admin', false, apiFeedback_],
  members: ['admin', false, apiMembers_],
  approve: ['admin', true, apiApprove_],
  reject: ['admin', true, apiReject_],
  reset_login: ['admin', true, apiResetLogin_],
  retire: ['admin', true, apiRetire_],
  restore: ['admin', true, apiRestore_],
  delete_now: ['admin', true, apiDeleteNow_],
  rename: ['admin', true, apiRename_],
  join_code: ['admin', false, function () { return prop_('join_code'); }],
  rotate_join_code: ['admin', true, apiRotateJoinCode_],
};

function dispatch_(req) {
  var route = ROUTES[req.action];
  if (!route) fail_('bad_request', 'unknown action');
  var run = function () {
    var ctx = { req: req };
    if (route[0] === 'staff' || route[0] === 'staff_any') {
      ctx.me = staffFromToken_(req.token);
      if (!ctx.me) fail_('unauthorized');
      if (route[0] === 'staff' && ctx.me.status !== 'active') fail_('forbidden', 'not approved');
    } else if (route[0] === 'admin') {
      if (!adminSessionValid_(req.token)) fail_('unauthorized');
    }
    return route[2](req, ctx);
  };
  if (!route[1]) return run();
  // 書き込みは 1 件ずつ順番に処理する（同時送信でもデータが壊れない）
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('busy', 'server busy');
  try {
    return run();
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// スプレッドシート（簡易テーブル層）
// ============================================================================
function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) fail_('not_initialized', 'run initialize()');
  return sh;
}

function cellToString_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}

/** 行を {列名: 文字列} の配列で返す。_row はシート上の行番号 */
function rows_(name) {
  var cols = TABLES[name];
  var values = sheet_(name).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var o = { _row: i + 1 };
    var empty = true;
    for (var c = 0; c < cols.length; c++) {
      o[cols[c]] = cellToString_(values[i][c]);
      if (o[cols[c]] !== '') empty = false;
    }
    if (!empty) out.push(o);
  }
  return out;
}

/** 数式として解釈されないようにする（=IMPORTXML などによる情報漏えい対策） */
function safeCell_(v) {
  var s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function toRow_(name, obj) {
  return TABLES[name].map(function (c) { return safeCell_(obj[c]); });
}

function insert_(name, obj) {
  sheet_(name).appendRow(toRow_(name, obj));
}

function update_(name, row, obj) {
  sheet_(name).getRange(row._row, 1, 1, TABLES[name].length).setValues([toRow_(name, obj)]);
}

/** 条件に合わない行だけを残してシートを書き直す（複数行の削除用） */
function keepRows_(name, keep) {
  var all = rows_(name);
  var kept = all.filter(keep);
  if (kept.length === all.length) return 0;
  var sh = sheet_(name);
  var n = TABLES[name].length;
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, n).clearContent();
  if (kept.length) sh.getRange(2, 1, kept.length, n).setValues(kept.map(function (r) { return toRow_(name, r); }));
  return all.length - kept.length;
}

function deleteRow_(name, row) {
  sheet_(name).deleteRow(row._row);
}

// ============================================================================
// ユーティリティ
// ============================================================================
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }
function delProp_(k) { PropertiesService.getScriptProperties().deleteProperty(k); }

function nowIso_() { return new Date().toISOString(); }

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function newSetupCode_() {
  return newToken_().slice(0, 12).toUpperCase();
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function sha256_(s) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

/** ソルト付き・反復ハッシュ（PIN とパスワード用） */
function hashSecret_(secret, salt) {
  var h = salt + ':' + secret;
  for (var i = 0; i < 2000; i++) h = sha256_(salt + h);
  return h;
}

function safeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function audit_(actor, action, target) {
  try {
    insert_('audit_logs', { at: nowIso_(), actor: actor, action: action, target: target || '' });
  } catch (e) { /* 監査ログの失敗で本処理を止めない */ }
}

/** いまの営業日（06:00 前は前日） */
function businessToday_() {
  return Utilities.formatDate(new Date(Date.now() - DAY_START * 60000), TZ, 'yyyy-MM-dd');
}

function addDays_(date, n) {
  var p = date.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}

// ---- 入力検証 ----
function str_(v, max, field) {
  var s = v === null || v === undefined ? '' : String(v).trim();
  if (s.length > max) fail_('invalid', field + ' too long');
  return s;
}
function name_(v) {
  var s = str_(v, 20, 'name').replace(/\s+/g, ' ');
  if (!s) fail_('invalid', 'name required');
  return s;
}
function norm_(s) { return String(s).trim().replace(/\s+/g, ' ').toLowerCase(); }
function pin_(v) {
  if (!/^\d{4}$/.test(String(v || ''))) fail_('invalid', 'PIN must be 4 digits');
  return String(v);
}
function date_(v) {
  var s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || addDays_(s, 0) !== s) fail_('invalid', 'bad date');
  return s;
}
function id_(v) {
  var s = String(v || '');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) fail_('invalid', 'bad id');
  return s;
}
function minutes_(v) {
  var n = Number(v);
  if (!isFinite(n) || n !== Math.floor(n) || n < DAY_START || n > DAY_END || n % 5 !== 0) fail_('invalid', 'bad time');
  return n;
}
function range_(s, e) {
  var a = minutes_(s);
  var b = minutes_(e);
  if (a >= b) fail_('invalid', 'start must be before end');
  return [a, b];
}

// ============================================================================
// スタッフの認証（端末トークン）
// ============================================================================
function staffFromToken_(token) {
  if (!token || String(token).length < 32) return null;
  var h = sha256_(String(token));
  var hit = null;
  rows_('members').forEach(function (m) {
    if (m.status !== 'retired' && m.token_hash && safeEqual_(m.token_hash, h)) hit = m;
  });
  return hit;
}

function checkJoinCode_(code) {
  var jc = prop_('join_code');
  return !!jc && safeEqual_(String(code || ''), jc);
}

function apiStoreInfo_(req) {
  return checkJoinCode_(req.code) ? { store_name: prop_('store_name') || '' } : null;
}

function apiRegister_(req) {
  if (!checkJoinCode_(req.code)) return { result: 'invalid_code' };
  var name = name_(req.name);
  var pin = pin_(req.pin);
  var members = rows_('members');
  if (members.filter(function (m) { return m.status === 'pending'; }).length >= MAX_PENDING) {
    return { result: 'too_many_pending' };
  }
  if (members.some(function (m) { return m.status !== 'retired' && norm_(m.display_name) === norm_(name); })) {
    return { result: 'name_taken' };
  }
  var token = newToken_();
  var salt = newToken_().slice(0, 16);
  var id = Utilities.getUuid();
  var maxOrder = members.reduce(function (a, m) { return Math.max(a, Number(m.sort_order) || 0); }, -1);
  insert_('members', {
    id: id, display_name: name, status: 'pending', pin_salt: salt, pin_hash: hashSecret_(pin, salt),
    token_hash: sha256_(token), failed_pin_count: '0', locked_until: '', sort_order: String(maxOrder + 1),
    created_at: nowIso_(), approved_at: '', retired_at: '',
  });
  audit_(id, 'member.register', id);
  return { result: 'pending', token: token };
}

/** PIN を 5 回間違えると 30 分ロック、累計 10 回で店長のリセットまでロック */
function apiLogin_(req) {
  if (!checkJoinCode_(req.code)) return { result: 'invalid_code' };
  var name = name_(req.name);
  var pin = pin_(req.pin);
  var m = null;
  rows_('members').forEach(function (x) {
    if ((x.status === 'pending' || x.status === 'active') && norm_(x.display_name) === norm_(name)) m = x;
  });
  if (!m) return { result: 'invalid' };
  if (m.locked_until && new Date(m.locked_until).getTime() > Date.now()) return { result: 'locked' };

  var token = newToken_();
  if (!m.pin_hash) {
    // 店長がリセット済み: 新しい PIN を設定して再承認待ちにする
    var salt = newToken_().slice(0, 16);
    m.pin_salt = salt;
    m.pin_hash = hashSecret_(pin, salt);
    m.token_hash = sha256_(token);
    m.status = 'pending';
    m.failed_pin_count = '0';
    m.locked_until = '';
    update_('members', m, m);
    audit_(m.id, 'member.pin_reset_claim', m.id);
    return { result: 'pending', token: token };
  }
  if (!safeEqual_(hashSecret_(pin, m.pin_salt), m.pin_hash)) {
    var failed = (Number(m.failed_pin_count) || 0) + 1;
    m.failed_pin_count = String(failed);
    if (failed >= 10) m.locked_until = '9999-12-31T00:00:00.000Z';
    else if (failed % 5 === 0) m.locked_until = new Date(Date.now() + 30 * 60000).toISOString();
    update_('members', m, m);
    audit_('', 'member.login_failed', m.id);
    return { result: 'invalid' };
  }
  // 成功: この端末に付け替える（旧端末のトークンは無効になる）
  m.token_hash = sha256_(token);
  m.failed_pin_count = '0';
  m.locked_until = '';
  update_('members', m, m);
  audit_(m.id, 'member.login', m.id);
  return { result: m.status === 'active' ? 'ok' : 'pending', token: token };
}

function apiMe_(req, ctx) {
  return {
    member_id: ctx.me.id,
    display_name: ctx.me.display_name,
    status: ctx.me.status,
    store_name: ctx.me.status === 'active' ? prop_('store_name') || '' : '',
  };
}

function apiLogout_(req, ctx) {
  ctx.me.token_hash = '';
  update_('members', ctx.me, ctx.me);
  return true;
}

// ============================================================================
// 期間・提出（スタッフ）
// ============================================================================
function periodOut_(p) {
  return {
    id: p.id, label: p.label, start_date: p.start_date, end_date: p.end_date, deadline: p.deadline || null,
    status: p.status, view_start_min: Number(p.view_start_min) || DAY_START, view_end_min: Number(p.view_end_min) || DAY_END,
  };
}

function listPeriods_(staffOnly) {
  return rows_('periods')
    .filter(function (p) { return !staffOnly || p.status !== 'draft'; })
    .sort(function (a, b) { return a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : 0; })
    .map(periodOut_);
}

function findPeriod_(id) {
  var pid = id_(id);
  var hit = null;
  rows_('periods').forEach(function (p) { if (p.id === pid) hit = p; });
  if (!hit) fail_('not_found', 'period not found');
  return hit;
}

function apiStaffPeriods_() {
  return listPeriods_(true);
}

function submissionOut_(s) {
  var days = [];
  try { days = JSON.parse(s.days_json || '[]'); } catch (e) { days = []; }
  return { member_id: s.member_id, note: s.note || null, updated_at: s.updated_at, days: days };
}

function apiMySubmission_(req, ctx) {
  var pid = id_(req.period_id);
  var hit = null;
  rows_('submissions').forEach(function (s) { if (s.period_id === pid && s.member_id === ctx.me.id) hit = s; });
  return hit ? submissionOut_(hit) : null;
}

function apiSubmitShift_(req, ctx) {
  var p = findPeriod_(req.period_id);
  if (p.status !== 'open' || (p.deadline && new Date(p.deadline).getTime() < Date.now())) {
    fail_('closed', 'period is not accepting submissions');
  }
  var input = req.days;
  if (!Array.isArray(input) || input.length > 32) fail_('invalid', 'days must be an array (max 32)');
  var seen = {};
  var days = input.map(function (d) {
    var date = date_(d && d.work_date);
    if (date < p.start_date || date > p.end_date || seen[date]) fail_('invalid', 'invalid day entry');
    seen[date] = true;
    var on = d.is_available === true;
    if (!on && d.is_available !== false) fail_('invalid', 'invalid day entry');
    var r = on ? range_(d.start_min, d.end_min) : [null, null];
    var note = str_(d.note, 200, 'note');
    return { work_date: date, is_available: on, start_min: r[0], end_min: r[1], note: note || null };
  });
  var note = str_(req.note, 500, 'note');
  var existing = null;
  rows_('submissions').forEach(function (s) { if (s.period_id === p.id && s.member_id === ctx.me.id) existing = s; });
  var row = { period_id: p.id, member_id: ctx.me.id, note: note, days_json: JSON.stringify(days), updated_at: nowIso_() };
  if (existing) update_('submissions', existing, row);
  else insert_('submissions', row);
  return true;
}

function apiSubmitFeedback_(req) {
  var body = str_(req.body, 1000, 'body');
  if (!body) fail_('invalid', 'body required');
  // 匿名: 投稿者は記録しない
  insert_('feedback', { id: Utilities.getUuid(), body: body, created_at: nowIso_() });
  return true;
}

/**
 * 代わり探しボード。承認済みスタッフ全員が閲覧可。
 * 公開するのは表示名・入れる時間帯・確定シフトだけ（備考や「休み」は返さない）。
 */
function apiBoard_(req, ctx) {
  var p = findPeriod_(req.period_id);
  if (p.status === 'draft') return [];
  var actives = {};
  rows_('members').forEach(function (m) { if (m.status === 'active') actives[m.id] = m; });
  var rows = {};
  var get = function (m, date) {
    var k = m.id + '|' + date;
    if (!rows[k]) {
      rows[k] = {
        member_id: m.id, display_name: m.display_name, sort_order: Number(m.sort_order) || 0, is_me: m.id === ctx.me.id,
        work_date: date, avail_start: null, avail_end: null, assign_start: null, assign_end: null,
      };
    }
    return rows[k];
  };
  rows_('submissions').forEach(function (s) {
    var m = actives[s.member_id];
    if (s.period_id !== p.id || !m) return;
    submissionOut_(s).days.forEach(function (d) {
      if (!d.is_available) return;
      var r = get(m, d.work_date);
      r.avail_start = d.start_min;
      r.avail_end = d.end_min;
    });
  });
  rows_('assignments').forEach(function (a) {
    var m = actives[a.member_id];
    if (a.period_id !== p.id || !m) return;
    var r = get(m, a.work_date);
    r.assign_start = Number(a.start_min);
    r.assign_end = Number(a.end_min);
  });
  return Object.keys(rows).map(function (k) { return rows[k]; });
}

// ============================================================================
// 店長の認証（パスワード + 認証アプリ）
// ============================================================================
function apiAdminStatus_() {
  if (prop_('admin_hash')) return 'ready';
  if (prop_('setup_code')) return 'needs_setup';
  return 'not_initialized';
}

function apiAdminSetup_(req) {
  var code = prop_('setup_code');
  if (!code || prop_('admin_hash')) fail_('forbidden', 'already set up');
  if (!safeEqual_(String(req.setup_code || '').trim().toUpperCase(), code)) {
    audit_('', 'admin.setup_failed', '');
    fail_('invalid_setup_code', 'wrong setup code');
  }
  var storeName = str_(req.store_name, 50, 'store_name');
  if (!storeName) fail_('invalid', 'store name required');
  var password = String(req.password || '');
  if (password.length < 10 || password.length > 128) fail_('weak_password', 'password must be 10+ chars');
  var secret = base32Encode_(randomBytes_(20));
  var salt = newToken_().slice(0, 16);
  setProp_('pending_admin', JSON.stringify({
    store_name: storeName, salt: salt, hash: hashSecret_(password, salt), secret: secret,
  }));
  return {
    secret: secret,
    otpauth: 'otpauth://totp/' + encodeURIComponent('シフト管理:' + storeName) +
      '?secret=' + secret + '&issuer=' + encodeURIComponent('シフト管理'),
  };
}

function apiAdminSetupVerify_(req) {
  var code = prop_('setup_code');
  var pending = prop_('pending_admin');
  if (!code || !pending || prop_('admin_hash')) fail_('forbidden', 'setup not started');
  if (!safeEqual_(String(req.setup_code || '').trim().toUpperCase(), code)) fail_('invalid_setup_code', 'wrong setup code');
  var p = JSON.parse(pending);
  var counter = verifyTotp_(p.secret, req.totp, 0);
  if (counter < 0) fail_('invalid_totp', 'wrong code');
  setProp_('store_name', p.store_name);
  setProp_('admin_salt', p.salt);
  setProp_('admin_hash', p.hash);
  setProp_('totp_secret', p.secret);
  setProp_('totp_last_counter', String(counter));
  delProp_('pending_admin');
  delProp_('setup_code');
  audit_('admin', 'admin.setup', '');
  return { token: newAdminSession_() };
}

function apiAdminLogin_(req) {
  if (!prop_('admin_hash')) fail_('forbidden', 'not set up');
  var locked = Number(prop_('admin_locked_until') || 0);
  if (locked > Date.now()) fail_('locked', 'too many attempts');
  var okPw = safeEqual_(hashSecret_(String(req.password || ''), prop_('admin_salt')), prop_('admin_hash'));
  var counter = okPw ? verifyTotp_(prop_('totp_secret'), req.totp, Number(prop_('totp_last_counter') || 0)) : -1;
  if (counter < 0) {
    var failed = Number(prop_('admin_failed') || 0) + 1;
    setProp_('admin_failed', String(failed));
    if (failed % 5 === 0) setProp_('admin_locked_until', String(Date.now() + 15 * 60000));
    audit_('', 'admin.login_failed', '');
    fail_('invalid_login', 'wrong password or code');
  }
  setProp_('totp_last_counter', String(counter));
  setProp_('admin_failed', '0');
  audit_('admin', 'admin.login', '');
  return { token: newAdminSession_() };
}

function adminSessions_() {
  var now = Date.now();
  var all = {};
  try { all = JSON.parse(prop_('admin_sessions') || '{}'); } catch (e) { all = {}; }
  var live = {};
  Object.keys(all).forEach(function (k) { if (all[k] > now) live[k] = all[k]; });
  return live;
}

function newAdminSession_() {
  var token = newToken_();
  var s = adminSessions_();
  s[sha256_(token)] = Date.now() + ADMIN_SESSION_DAYS * 86400000;
  // 端末は最大 5 台まで（古いものから破棄）
  var keys = Object.keys(s).sort(function (a, b) { return s[b] - s[a]; }).slice(0, 5);
  var kept = {};
  keys.forEach(function (k) { kept[k] = s[k]; });
  setProp_('admin_sessions', JSON.stringify(kept));
  return token;
}

function adminSessionValid_(token) {
  if (!token || !prop_('admin_hash')) return false;
  return !!adminSessions_()[sha256_(String(token))];
}

function apiAdminLogout_(req) {
  var s = adminSessions_();
  delete s[sha256_(String(req.token))];
  setProp_('admin_sessions', JSON.stringify(s));
  return true;
}

// ---- TOTP（RFC 6238, 30 秒, 6 桁, SHA-1） ----
function randomBytes_(n) {
  var hex = '';
  while (hex.length < n * 2) hex += Utilities.getUuid().replace(/-/g, '');
  var out = [];
  for (var i = 0; i < n; i++) out.push(parseInt(hex.substr(i * 2, 2), 16));
  return out;
}

var B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode_(bytes) {
  var bits = 0, value = 0, out = '';
  for (var i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] & 0xff);
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode_(str) {
  var bits = 0, value = 0, out = [];
  str = String(str).replace(/=+$/, '').toUpperCase();
  for (var i = 0; i < str.length; i++) {
    var idx = B32.indexOf(str[i]);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return out;
}
function signed_(bytes) { return bytes.map(function (b) { return b > 127 ? b - 256 : b; }); }

function totpAt_(secret, counter) {
  var msg = [];
  var c = counter;
  for (var i = 7; i >= 0; i--) { msg[i] = c % 256; c = Math.floor(c / 256); }
  var h = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, signed_(msg), signed_(base32Decode_(secret)))
    .map(function (b) { return b & 0xff; });
  var o = h[19] & 0xf;
  var bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return ('000000' + (bin % 1000000)).slice(-6);
}

/** 一致した時間枠の番号を返す（不一致は -1）。lastCounter 以下は再利用とみなして拒否 */
function verifyTotp_(secret, code, lastCounter) {
  code = String(code || '');
  if (!/^\d{6}$/.test(code) || !secret) return -1;
  var now = Math.floor(Date.now() / 30000);
  for (var w = -1; w <= 1; w++) {
    var counter = now + w;
    if (counter > lastCounter && safeEqual_(totpAt_(secret, counter), code)) return counter;
  }
  return -1;
}

// ============================================================================
// 店長の操作
// ============================================================================
function memberOut_(m) {
  return {
    id: m.id, display_name: m.display_name, role: 'staff', status: m.status, sort_order: Number(m.sort_order) || 0,
    created_at: m.created_at, approved_at: m.approved_at || null, retired_at: m.retired_at || null,
    locked_until: m.locked_until || null,
  };
}

function findMember_(id) {
  var mid = id_(id);
  var hit = null;
  rows_('members').forEach(function (m) { if (m.id === mid) hit = m; });
  if (!hit) fail_('not_found', 'member not found');
  return hit;
}

function apiCreatePeriod_(req) {
  var label = str_(req.label, 30, 'label');
  if (!label) fail_('invalid', 'label required');
  var start = date_(req.start_date);
  var end = date_(req.end_date);
  if (end < start || addDays_(start, 31) < end) fail_('invalid', 'period must be 1-32 days');
  var deadline = req.deadline ? new Date(req.deadline) : null;
  if (deadline && isNaN(deadline.getTime())) fail_('invalid', 'bad deadline');
  var r = range_(req.view_start_min || DAY_START, req.view_end_min || DAY_END);
  var id = Utilities.getUuid();
  insert_('periods', {
    id: id, label: label, start_date: start, end_date: end, deadline: deadline ? deadline.toISOString() : '',
    status: 'draft', view_start_min: String(r[0]), view_end_min: String(r[1]), created_at: nowIso_(),
  });
  audit_('admin', 'period.create', id);
  return id;
}

function apiSetPeriodStatus_(req) {
  var p = findPeriod_(req.period_id);
  if (['draft', 'open', 'closed'].indexOf(req.status) < 0) fail_('invalid', 'bad status');
  p.status = req.status;
  update_('periods', p, p);
  audit_('admin', 'period.status', p.id);
  return true;
}

function apiDeletePeriod_(req) {
  var p = findPeriod_(req.period_id);
  deleteRow_('periods', p);
  keepRows_('submissions', function (s) { return s.period_id !== p.id; });
  keepRows_('assignments', function (a) { return a.period_id !== p.id; });
  audit_('admin', 'period.delete', p.id);
  return true;
}

function apiTimeline_(req) {
  var p = findPeriod_(req.period_id);
  return {
    members: rows_('members').filter(function (m) { return m.status === 'active'; })
      .sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); }).map(memberOut_),
    submissions: rows_('submissions').filter(function (s) { return s.period_id === p.id; }).map(submissionOut_),
    assignments: rows_('assignments').filter(function (a) { return a.period_id === p.id; }).map(function (a) {
      return { member_id: a.member_id, work_date: a.work_date, start_min: Number(a.start_min), end_min: Number(a.end_min) };
    }),
  };
}

function apiSetAssignment_(req) {
  var p = findPeriod_(req.period_id);
  var m = findMember_(req.member_id);
  if (m.status !== 'active') fail_('invalid', 'member is not active');
  var date = date_(req.work_date);
  if (date < p.start_date || date > p.end_date) fail_('invalid', 'date out of period');
  var r = range_(req.start_min, req.end_min);
  var row = { period_id: p.id, member_id: m.id, work_date: date, start_min: String(r[0]), end_min: String(r[1]), updated_at: nowIso_() };
  var existing = null;
  rows_('assignments').forEach(function (a) { if (a.member_id === m.id && a.work_date === date) existing = a; });
  if (existing) update_('assignments', existing, row);
  else insert_('assignments', row);
  return true;
}

function apiRemoveAssignment_(req) {
  var mid = id_(req.member_id);
  var date = date_(req.work_date);
  keepRows_('assignments', function (a) { return !(a.member_id === mid && a.work_date === date); });
  return true;
}

function apiUnsubmitted_(req) {
  var p = findPeriod_(req.period_id);
  var done = {};
  rows_('submissions').forEach(function (s) { if (s.period_id === p.id) done[s.member_id] = true; });
  return rows_('members')
    .filter(function (m) { return m.status === 'active' && !done[m.id]; })
    .sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); })
    .map(function (m) { return { member_id: m.id, display_name: m.display_name }; });
}

function apiFeedback_() {
  return rows_('feedback')
    .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; })
    .map(function (f) { return { id: f.id, body: f.body, created_at: f.created_at }; });
}

function apiMembers_() {
  return rows_('members')
    .sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); })
    .map(memberOut_);
}

function apiApprove_(req) {
  var m = findMember_(req.member_id);
  if (m.status !== 'pending') fail_('invalid', 'not pending');
  m.status = 'active';
  m.approved_at = nowIso_();
  update_('members', m, m);
  audit_('admin', 'member.approve', m.id);
  return true;
}

function apiReject_(req) {
  var m = findMember_(req.member_id);
  if (m.status !== 'pending' || m.approved_at) fail_('invalid', 'only new pending members can be rejected');
  deleteRow_('members', m);
  audit_('admin', 'member.reject', m.id);
  return true;
}

function apiResetLogin_(req) {
  var m = findMember_(req.member_id);
  if (m.status === 'retired') fail_('invalid', 'member is retired');
  m.pin_hash = '';
  m.pin_salt = '';
  m.token_hash = '';
  m.status = 'pending';
  m.failed_pin_count = '0';
  m.locked_until = '';
  update_('members', m, m);
  audit_('admin', 'member.reset_login', m.id);
  return true;
}

/** 退職処理: 即時にアクセス不能にし、今日以降の確定シフトを外す（30 日後に自動で完全削除） */
function apiRetire_(req) {
  var m = findMember_(req.member_id);
  if (m.status === 'retired') fail_('invalid', 'already retired');
  m.status = 'retired';
  m.token_hash = '';
  m.retired_at = nowIso_();
  update_('members', m, m);
  var today = businessToday_();
  keepRows_('assignments', function (a) { return !(a.member_id === m.id && a.work_date >= today); });
  audit_('admin', 'member.retire', m.id);
  return true;
}

function apiRestore_(req) {
  var m = findMember_(req.member_id);
  if (m.status !== 'retired') fail_('invalid', 'not retired');
  var clash = rows_('members').some(function (x) {
    return x.id !== m.id && x.status !== 'retired' && norm_(x.display_name) === norm_(m.display_name);
  });
  if (clash) fail_('name_taken', 'same name exists');
  m.status = 'active';
  m.retired_at = '';
  update_('members', m, m);
  audit_('admin', 'member.restore', m.id);
  return true;
}

function deleteMemberData_(id) {
  keepRows_('members', function (x) { return x.id !== id; });
  keepRows_('submissions', function (s) { return s.member_id !== id; });
  keepRows_('assignments', function (a) { return a.member_id !== id; });
}

function apiDeleteNow_(req) {
  var m = findMember_(req.member_id);
  if (m.status !== 'retired') fail_('invalid', 'retire first');
  deleteMemberData_(m.id);
  audit_('admin', 'member.delete', m.id);
  return true;
}

function apiRename_(req) {
  var m = findMember_(req.member_id);
  var name = name_(req.name);
  var clash = rows_('members').some(function (x) {
    return x.id !== m.id && x.status !== 'retired' && norm_(x.display_name) === norm_(name);
  });
  if (clash) fail_('name_taken', 'same name exists');
  m.display_name = name;
  update_('members', m, m);
  return true;
}

function apiRotateJoinCode_() {
  var code = newToken_().slice(0, 32);
  setProp_('join_code', code);
  audit_('admin', 'join_code.rotate', '');
  return code;
}

// ============================================================================
// 保持期間を過ぎたデータの削除（毎日 3 時台に自動実行）
// ============================================================================
function purgeExpiredData() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) return;
  try {
    var now = Date.now();
    var day = 86400000;
    var gone = {};
    rows_('members').forEach(function (m) {
      var retiredOld = m.status === 'retired' && m.retired_at && now - new Date(m.retired_at).getTime() > 30 * day;
      var pendingOld = m.status === 'pending' && !m.approved_at && now - new Date(m.created_at).getTime() > 30 * day;
      if (retiredOld || pendingOld) gone[m.id] = true;
    });
    keepRows_('members', function (m) { return !gone[m.id]; });
    var cutoff = addDays_(businessToday_(), -180);
    var oldPeriods = {};
    rows_('periods').forEach(function (p) { if (p.end_date < cutoff) oldPeriods[p.id] = true; });
    keepRows_('periods', function (p) { return !oldPeriods[p.id]; });
    keepRows_('submissions', function (s) { return !gone[s.member_id] && !oldPeriods[s.period_id]; });
    keepRows_('assignments', function (a) { return !gone[a.member_id] && !oldPeriods[a.period_id]; });
    var yearAgo = new Date(now - 365 * day).toISOString();
    keepRows_('feedback', function (f) { return f.created_at >= yearAgo; });
    keepRows_('audit_logs', function (l) { return l.at >= yearAgo; });
  } finally {
    lock.releaseLock();
  }
}
