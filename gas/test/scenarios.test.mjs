// gas/Code.gs の権限・業務ルールのシナリオテスト（node --test で実行）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGas } from '../dev/gas-runtime.mjs';

function setup() {
  const gas = createGas();
  gas.ctx.initialize();
  const ok = (body) => {
    const r = gas.post(body);
    assert.equal(r.ok, true, `${body.action}: ${JSON.stringify(r)}`);
    return r.data;
  };
  const err = (body) => {
    const r = gas.post(body);
    assert.equal(r.ok, false, `${body.action} should fail`);
    return r.error;
  };
  const code = gas.props.get('join_code');
  const totp = (secret, offset = 0) => gas.ctx.totpAt_(secret, Math.floor(Date.now() / 30000) + offset);

  // 店長の初期設定
  const setupCode = gas.props.get('setup_code');
  const enroll = ok({ action: 'admin_setup', setup_code: setupCode, store_name: 'テスト店', password: 'correct horse' });
  const admin = ok({ action: 'admin_setup_verify', setup_code: setupCode, totp: totp(enroll.secret) }).token;
  const periodId = ok({ action: 'create_period', token: admin, label: '10月前半', start_date: '2026-10-01', end_date: '2026-10-15' });
  ok({ action: 'set_period_status', token: admin, period_id: periodId, status: 'open' });
  return { gas, ok, err, code, admin, periodId, secret: enroll.secret, totp };
}

test('TOTP matches RFC 6238 test vector', () => {
  const gas = createGas();
  const secret = gas.ctx.base32Encode_([...Buffer.from('12345678901234567890')]);
  assert.equal(gas.ctx.totpAt_(secret, 1), '287082'); // T=59s
  assert.equal(gas.ctx.totpAt_(secret, 37037036), '081804'); // T=1111111109s
});

test('admin setup, login and lockout', () => {
  const { gas, ok, err, secret, totp } = setup();
  assert.equal(ok({ action: 'admin_status' }), 'ready');
  assert.equal(err({ action: 'admin_setup', setup_code: 'X', store_name: 'x', password: 'xxxxxxxxxxxx' }), 'forbidden');
  assert.equal(err({ action: 'members' }), 'unauthorized');
  assert.equal(err({ action: 'admin_login', password: 'wrong password', totp: totp(secret, 1) }), 'invalid_login');
  // 同じコードの再利用は拒否（セットアップ時に使った枠）
  assert.equal(err({ action: 'admin_login', password: 'correct horse', totp: totp(secret, -1) }), 'invalid_login');
  const t = ok({ action: 'admin_login', password: 'correct horse', totp: totp(secret, 1) }).token;
  assert.ok(ok({ action: 'members', token: t }));
  for (let i = 0; i < 5; i++) err({ action: 'admin_login', password: 'nope', totp: '000000' });
  assert.equal(err({ action: 'admin_login', password: 'correct horse', totp: totp(secret, 1) }), 'locked');
  ok({ action: 'admin_logout', token: t });
  assert.equal(err({ action: 'members', token: t }), 'unauthorized');
  assert.ok(gas.props.get('admin_hash') && !gas.props.get('admin_hash').includes('correct'));
});

test('staff registration, approval, submission and visibility', () => {
  const { ok, err, code, admin, periodId } = setup();
  const reg = (name, pin) => ok({ action: 'register', code, name, pin });

  const a = reg('山田', '1234');
  assert.equal(a.result, 'pending');
  const b = reg('佐藤', '5678');
  assert.equal(reg(' 山田 ', '0000').result, 'name_taken');
  assert.equal(ok({ action: 'register', code: 'bad', name: '鈴木', pin: '0000' }).result, 'invalid_code');
  assert.equal(ok({ action: 'store_info', code }).store_name, 'テスト店');
  assert.equal(ok({ action: 'store_info', code: 'bad' }), null);

  // 承認待ちは提出も閲覧もできない
  assert.equal(ok({ action: 'me', token: a.token }).status, 'pending');
  assert.equal(err({ action: 'periods', token: a.token }), 'forbidden');
  assert.equal(err({ action: 'board', token: a.token, period_id: periodId }), 'forbidden');

  const members = ok({ action: 'members', token: admin });
  for (const m of members) ok({ action: 'approve', token: admin, member_id: m.id });
  assert.ok(!JSON.stringify(members).includes('pin_hash'));

  // 提出: 17:05〜翌1:30。休みの日の時刻は捨てる
  ok({
    action: 'submit_shift', token: a.token, period_id: periodId, note: '全体備考A',
    days: [
      { work_date: '2026-10-01', is_available: true, start_min: 1025, end_min: 1530, note: '非公開メモ' },
      { work_date: '2026-10-02', is_available: false, start_min: 600, end_min: 700 },
    ],
  });
  const mine = ok({ action: 'my_submission', token: a.token, period_id: periodId });
  assert.deepEqual(mine.days[1], { work_date: '2026-10-02', is_available: false, start_min: null, end_min: null, note: null });
  const bad = (d) => err({ action: 'submit_shift', token: a.token, period_id: periodId, note: '', days: [d] });
  assert.equal(bad({ work_date: '2026-10-03', is_available: true, start_min: 300, end_min: 600 }), 'invalid');
  assert.equal(bad({ work_date: '2026-10-03', is_available: true, start_min: 600, end_min: 1565 }), 'invalid');
  assert.equal(bad({ work_date: '2026-10-03', is_available: true, start_min: 603, end_min: 720 }), 'invalid');
  assert.equal(bad({ work_date: '2026-10-20', is_available: false }), 'invalid');
  ok({ action: 'submit_feedback', token: a.token, body: '見やすくしてほしい' });

  ok({ action: 'submit_shift', token: b.token, period_id: periodId, note: '全体備考B', days: [{ work_date: '2026-10-01', is_available: true, start_min: 600, end_min: 900 }] });
  const bId = members.find((m) => m.display_name === '佐藤').id;
  ok({ action: 'set_assignment', token: admin, period_id: periodId, member_id: bId, work_date: '2026-10-01', start_min: 600, end_min: 900 });
  assert.equal(err({ action: 'set_assignment', token: admin, period_id: periodId, member_id: bId, work_date: '2026-11-01', start_min: 600, end_min: 900 }), 'invalid');

  // B から見たボード: A の時間帯は見えるが備考は含まれない
  const board = ok({ action: 'board', token: b.token, period_id: periodId });
  assert.equal(board.length, 2);
  const yamada = board.find((r) => r.display_name === '山田');
  assert.equal(`${yamada.avail_start}-${yamada.avail_end}`, '1025-1530');
  assert.equal(board.find((r) => r.is_me).assign_start, 600);
  assert.ok(!JSON.stringify(board).includes('備考') && !JSON.stringify(board).includes('メモ'));
  // スタッフは店長用の操作を呼べない
  assert.equal(err({ action: 'timeline', token: b.token, period_id: periodId }), 'unauthorized');
  assert.equal(err({ action: 'feedback', token: b.token }), 'unauthorized');

  // 店長は備考付きで全員分を見られる
  const tl = ok({ action: 'timeline', token: admin, period_id: periodId });
  assert.equal(tl.submissions.length, 2);
  assert.equal(ok({ action: 'feedback', token: admin }).length, 1);
  assert.equal(ok({ action: 'unsubmitted', token: admin, period_id: periodId }).length, 0);
});

test('device change, PIN lockout, reset, retire and URL rotation', () => {
  const { gas, ok, err, code, admin, periodId } = setup();
  const a = ok({ action: 'register', code, name: '山田', pin: '1234' });
  const id = ok({ action: 'members', token: admin })[0].id;
  ok({ action: 'approve', token: admin, member_id: id });

  // 新端末でログイン → 旧端末は無効
  assert.equal(ok({ action: 'login', code, name: '山田', pin: '0000' }).result, 'invalid');
  for (let i = 0; i < 4; i++) ok({ action: 'login', code, name: '山田', pin: '0000' });
  assert.equal(ok({ action: 'login', code, name: '山田', pin: '1234' }).result, 'locked');
  const m = gas.ctx.rows_('members')[0];
  m.locked_until = new Date(Date.now() - 1000).toISOString();
  gas.ctx.update_('members', m, m);
  const b = ok({ action: 'login', code, name: '山田', pin: '1234' });
  assert.equal(b.result, 'ok');
  assert.equal(err({ action: 'me', token: a.token }), 'unauthorized');
  assert.equal(ok({ action: 'me', token: b.token }).status, 'active');

  // PIN リセット → 新しい PIN で再承認待ち
  ok({ action: 'reset_login', token: admin, member_id: id });
  assert.equal(err({ action: 'me', token: b.token }), 'unauthorized');
  const c = ok({ action: 'login', code, name: '山田', pin: '9999' });
  assert.equal(c.result, 'pending');
  ok({ action: 'approve', token: admin, member_id: id });
  assert.equal(ok({ action: 'me', token: c.token }).status, 'active');

  // 退職処理 → 即時に無効、ボードからも消える。完全削除で提出も消える
  ok({ action: 'submit_shift', token: c.token, period_id: periodId, note: '', days: [{ work_date: '2026-10-01', is_available: false }] });
  ok({ action: 'retire', token: admin, member_id: id });
  assert.equal(err({ action: 'me', token: c.token }), 'unauthorized');
  assert.equal(ok({ action: 'login', code, name: '山田', pin: '9999' }).result, 'invalid');
  ok({ action: 'delete_now', token: admin, member_id: id });
  assert.equal(gas.ctx.rows_('submissions').length, 0);
  assert.equal(gas.ctx.rows_('members').length, 0);

  // URL 再発行で旧 URL は無効
  const newCode = ok({ action: 'rotate_join_code', token: admin });
  assert.equal(ok({ action: 'register', code, name: '鈴木', pin: '1111' }).result, 'invalid_code');
  assert.equal(ok({ action: 'register', code: newCode, name: '鈴木', pin: '1111' }).result, 'pending');
});

test('cells starting with = are stored as text (formula injection)', () => {
  const { gas, ok, code, admin } = setup();
  ok({ action: 'register', code, name: '=SUM(A1:A9)', pin: '1234' });
  const id = ok({ action: 'members', token: admin })[0].id;
  ok({ action: 'approve', token: admin, member_id: id });
  const raw = gas.sheets.get('members').grid[1][1];
  assert.equal(raw, '=SUM(A1:A9)'); // モックは先頭の ' を外して保存（＝文字列扱い）
  const written = gas.ctx.safeCell_('=SUM(1)');
  assert.equal(written, "'=SUM(1)");
});

test('purge removes old retired members and old periods', () => {
  const { gas, ok, code, admin } = setup();
  ok({ action: 'register', code, name: '山田', pin: '1234' });
  const id = ok({ action: 'members', token: admin })[0].id;
  ok({ action: 'approve', token: admin, member_id: id });
  ok({ action: 'retire', token: admin, member_id: id });
  const m = gas.ctx.rows_('members')[0];
  m.retired_at = new Date(Date.now() - 31 * 86400000).toISOString();
  gas.ctx.update_('members', m, m);
  ok({ action: 'create_period', token: admin, label: '昔', start_date: '2020-01-01', end_date: '2020-01-15' });
  gas.ctx.purgeExpiredData();
  assert.equal(gas.ctx.rows_('members').length, 0);
  assert.deepEqual(Array.from(gas.ctx.rows_('periods'), (p) => p.label), ['10月前半']);
});
