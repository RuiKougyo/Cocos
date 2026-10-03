// デモモード: Supabase 未設定時に、ブラウザ内（localStorage）のサンプルデータで動かす。
// 公開範囲などのルールは DB の RLS / RPC と同じ振る舞いになるように実装している。
import { addDays, businessToday, datesBetween, DAY_END, DAY_START } from './time';
import type {
  AdminApi, Assignment, BoardRow, DayEntry, Feedback, LoginResult, Member, Period,
  RegisterResult, StaffApi, Submission,
} from './types';

export const DEMO_CODE = 'demo';
const KEY = 'cocos-demo-db';
const UID_KEY = 'cocos-demo-uid';

interface DemoMember extends Member { user_id: string | null; pin: string | null; failed: number }
interface DB {
  storeName: string;
  joinCode: string;
  members: DemoMember[];
  periods: Period[];
  submissions: (Submission & { period_id: string })[];
  assignments: (Assignment & { period_id: string })[];
  feedback: Feedback[];
}

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function seed(): DB {
  const today = businessToday();
  const [y, m, d] = today.split('-').map(Number);
  const firstHalf = d <= 15;
  const start = `${y}-${String(m).padStart(2, '0')}-${firstHalf ? '01' : '16'}`;
  const endDay = firstHalf ? 15 : new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
  const nextStart = addDays(end, 1);
  const period: Period = { id: id(), label: `${m}月${firstHalf ? '前半' : '後半'}`, start_date: start, end_date: end, deadline: null, status: 'open', view_start_min: DAY_START, view_end_min: DAY_END };
  const next: Period = { id: id(), label: '次の期間（下書き）', start_date: nextStart, end_date: addDays(nextStart, 14), deadline: null, status: 'draft', view_start_min: DAY_START, view_end_min: DAY_END };

  const names = ['山田', '佐藤', '鈴木', '田中', '高橋', '伊藤', '渡辺'];
  const members: DemoMember[] = names.map((n, i) => ({
    id: id(), display_name: n, role: 'staff', status: 'active', sort_order: i, created_at: now(),
    approved_at: now(), retired_at: null, locked_until: null, user_id: null, pin: '1234', failed: 0,
  }));
  members.push({ id: id(), display_name: '小林', role: 'staff', status: 'pending', sort_order: 99, created_at: now(), approved_at: null, retired_at: null, locked_until: null, user_id: 'someone-else', pin: '1234', failed: 0 });

  // 疑似乱数で希望を作る（毎回同じ結果）
  let s = 7;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const patterns: [number, number][] = [[600, 900], [660, 1020], [1020, 1320], [1080, 1530], [960, 1440], [1200, 1560], [540, 1080]];
  const submissions: DB['submissions'] = [];
  const assignments: DB['assignments'] = [];
  members.slice(0, 6).forEach((mem, i) => {
    if (i === 5) return; // 伊藤は未提出
    const days: DayEntry[] = datesBetween(start, end).map((date) => {
      const avail = rnd() < 0.62;
      const [a, b] = patterns[Math.floor(rnd() * patterns.length)];
      return { work_date: date, is_available: avail, start_min: avail ? a : null, end_min: avail ? b : null, note: avail && rnd() < 0.08 ? '早めに上がれると助かります' : null };
    });
    submissions.push({ period_id: period.id, member_id: mem.id, note: i === 2 ? 'テスト期間のため週3まで' : null, updated_at: now(), days });
    days.forEach((day, k) => {
      if (day.is_available && (k + i) % 2 === 0) {
        assignments.push({ period_id: period.id, member_id: mem.id, work_date: day.work_date, start_min: day.start_min!, end_min: day.end_min! });
      }
    });
  });

  return {
    storeName: 'デモ店', joinCode: DEMO_CODE, members, periods: [period, next], submissions, assignments,
    feedback: [{ id: id(), body: '前の期間の内容をコピーできると嬉しいです', created_at: now() }],
  };
}

function load(): DB {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as DB;
  } catch { /* 破損時は作り直す */ }
  const db = seed();
  save(db);
  return db;
}
function save(db: DB) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* 保存できなくても動作は続ける */ }
}
function myUid(): string {
  let u = localStorage.getItem(UID_KEY);
  if (!u) { u = id(); localStorage.setItem(UID_KEY, u); }
  return u;
}
const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120));
const norm = (n: string) => n.trim().toLowerCase();
const strip = (m: DemoMember): Member => {
  const { user_id: _u, pin: _p, failed: _f, ...rest } = m;
  return rest;
};

export function resetDemo() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(UID_KEY);
}

export function createDemoStaffApi(): StaffApi {
  const meRow = (db: DB) => db.members.find((m) => m.user_id === myUid() && m.status !== 'retired');
  const active = (db: DB) => { const m = meRow(db); return m && m.status === 'active' ? m : undefined; };
  return {
    async ensureSession() { myUid(); },
    async storeByCode(code) { const db = load(); return delay(code === db.joinCode ? db.storeName : null); },
    async register(code, name, pin): Promise<RegisterResult> {
      const db = load();
      if (code !== db.joinCode) return 'invalid_code';
      if (meRow(db)) return 'already_linked';
      if (db.members.some((m) => m.status !== 'retired' && norm(m.display_name) === norm(name))) return 'name_taken';
      db.members.push({ id: id(), display_name: name.trim(), role: 'staff', status: 'pending', sort_order: db.members.length, created_at: now(), approved_at: null, retired_at: null, locked_until: null, user_id: myUid(), pin, failed: 0 });
      save(db);
      return delay('pending');
    },
    async login(code, name, pin): Promise<LoginResult> {
      const db = load();
      if (code !== db.joinCode) return 'invalid_code';
      if (meRow(db)) return 'already_linked';
      const m = db.members.find((x) => x.status !== 'retired' && norm(x.display_name) === norm(name));
      if (!m) return 'invalid';
      if (m.locked_until && new Date(m.locked_until) > new Date()) return 'locked';
      if (m.pin === null) { m.pin = pin; m.user_id = myUid(); m.status = 'pending'; save(db); return 'pending'; }
      if (m.pin !== pin) {
        m.failed += 1;
        if (m.failed >= 10) m.locked_until = '9999-12-31T00:00:00Z';
        else if (m.failed % 5 === 0) m.locked_until = new Date(Date.now() + 30 * 60_000).toISOString();
        save(db);
        return 'invalid';
      }
      m.failed = 0; m.locked_until = null; m.user_id = myUid();
      save(db);
      return delay(m.status === 'active' ? 'ok' : 'pending');
    },
    async logout() {
      const db = load();
      const m = meRow(db);
      if (m) { m.user_id = null; save(db); }
    },
    async me() {
      const db = load();
      const m = meRow(db);
      return delay(m ? { member_id: m.id, display_name: m.display_name, status: m.status, store_name: m.status === 'active' ? db.storeName : '' } : null);
    },
    async periods() {
      const db = load();
      return delay(active(db) ? db.periods.filter((p) => p.status !== 'draft') : []);
    },
    async mySubmission(periodId) {
      const db = load();
      const m = active(db);
      return delay(db.submissions.find((s) => s.period_id === periodId && s.member_id === m?.id) ?? null);
    },
    async submitShift(periodId, note, days) {
      const db = load();
      const m = active(db);
      const p = db.periods.find((x) => x.id === periodId);
      if (!m || !p || p.status !== 'open') throw new Error('period is not accepting submissions');
      for (const d of days) {
        if (d.work_date < p.start_date || d.work_date > p.end_date) throw new Error('invalid day entry');
        if (d.is_available && (d.start_min == null || d.end_min == null || d.start_min < DAY_START || d.end_min > DAY_END || d.start_min >= d.end_min || d.start_min % 5 || d.end_min % 5)) {
          throw new Error('invalid time');
        }
      }
      const clean = days.map((d) => (d.is_available ? d : { ...d, start_min: null, end_min: null }));
      db.submissions = db.submissions.filter((s) => !(s.period_id === periodId && s.member_id === m.id));
      db.submissions.push({ period_id: periodId, member_id: m.id, note: note.trim() || null, updated_at: now(), days: clean });
      save(db);
      await delay(null);
    },
    async submitFeedback(body) {
      const db = load();
      if (!active(db)) throw new Error('active member required');
      db.feedback.unshift({ id: id(), body: body.trim(), created_at: now() });
      save(db);
    },
    async board(periodId) {
      const db = load();
      const me = active(db);
      const p = db.periods.find((x) => x.id === periodId);
      if (!me || !p || p.status === 'draft') return [];
      const rows = new Map<string, BoardRow>();
      const get = (m: DemoMember, date: string) => {
        const k = `${m.id}|${date}`;
        if (!rows.has(k)) rows.set(k, { member_id: m.id, display_name: m.display_name, sort_order: m.sort_order, is_me: m.id === me.id, work_date: date, avail_start: null, avail_end: null, assign_start: null, assign_end: null });
        return rows.get(k)!;
      };
      const actives = new Map(db.members.filter((m) => m.status === 'active').map((m) => [m.id, m]));
      for (const s of db.submissions.filter((x) => x.period_id === periodId)) {
        const m = actives.get(s.member_id);
        if (!m) continue;
        for (const d of s.days.filter((x) => x.is_available)) Object.assign(get(m, d.work_date), { avail_start: d.start_min, avail_end: d.end_min });
      }
      for (const a of db.assignments.filter((x) => x.period_id === periodId)) {
        const m = actives.get(a.member_id);
        if (m) Object.assign(get(m, a.work_date), { assign_start: a.start_min, assign_end: a.end_min });
      }
      return delay([...rows.values()]);
    },
  };
}

export function createDemoAdminApi(): AdminApi {
  let state: 'none' | 'mfa' | 'ok' = (sessionStorage.getItem('cocos-demo-admin') as 'ok' | null) ?? 'none';
  const find = (db: DB, mid: string) => {
    const m = db.members.find((x) => x.id === mid);
    if (!m) throw new Error('member not found');
    return m;
  };
  const mutate = async (fn: (db: DB) => void) => { const db = load(); fn(db); save(db); await delay(null); };
  return {
    loginKind: 'email',
    async session() { return state; },
    async signIn() { state = 'mfa'; return delay({ next: 'mfa' as const }); },
    async verifyMfa(code) {
      if (!/^\d{6}$/.test(code)) throw new Error('6桁のコードを入力してください');
      state = 'ok';
      sessionStorage.setItem('cocos-demo-admin', 'ok');
    },
    async signOut() { state = 'none'; sessionStorage.removeItem('cocos-demo-admin'); },
    async me() { const db = load(); return delay({ member_id: 'admin', display_name: '店長', store_id: 'demo', store_name: db.storeName }); },
    async createStore() {},

    async periods() { return delay([...load().periods].sort((a, b) => b.start_date.localeCompare(a.start_date))); },
    async createPeriod(p) { await mutate((db) => db.periods.push({ ...p, id: id(), status: 'draft' })); },
    async setPeriodStatus(pid, status) { await mutate((db) => { db.periods.find((p) => p.id === pid)!.status = status; }); },
    async deletePeriod(pid) {
      await mutate((db) => {
        db.periods = db.periods.filter((p) => p.id !== pid);
        db.submissions = db.submissions.filter((s) => s.period_id !== pid);
        db.assignments = db.assignments.filter((a) => a.period_id !== pid);
      });
    },

    async timeline(periodId) {
      const db = load();
      return delay({
        members: db.members.filter((m) => m.status === 'active').sort((a, b) => a.sort_order - b.sort_order).map(strip),
        submissions: db.submissions.filter((s) => s.period_id === periodId),
        assignments: db.assignments.filter((a) => a.period_id === periodId),
      });
    },
    async setAssignment(periodId, a) {
      await mutate((db) => {
        db.assignments = db.assignments.filter((x) => !(x.member_id === a.member_id && x.work_date === a.work_date));
        db.assignments.push({ ...a, period_id: periodId });
      });
    },
    async removeAssignment(memberId, workDate) {
      await mutate((db) => { db.assignments = db.assignments.filter((x) => !(x.member_id === memberId && x.work_date === workDate)); });
    },
    async unsubmitted(periodId) {
      const db = load();
      const done = new Set(db.submissions.filter((s) => s.period_id === periodId).map((s) => s.member_id));
      return delay(db.members.filter((m) => m.status === 'active' && !done.has(m.id)).map((m) => ({ member_id: m.id, display_name: m.display_name })));
    },
    async feedback() { return delay(load().feedback); },

    async members() { return delay(load().members.sort((a, b) => a.sort_order - b.sort_order).map(strip)); },
    async approve(mid) { await mutate((db) => { const m = find(db, mid); m.status = 'active'; m.approved_at = now(); }); },
    async reject(mid) { await mutate((db) => { db.members = db.members.filter((m) => m.id !== mid); }); },
    async resetLogin(mid) { await mutate((db) => { Object.assign(find(db, mid), { user_id: null, pin: null, status: 'pending', failed: 0, locked_until: null }); }); },
    async retire(mid) {
      await mutate((db) => {
        Object.assign(find(db, mid), { status: 'retired', user_id: null, retired_at: now() });
        const today = businessToday();
        db.assignments = db.assignments.filter((a) => !(a.member_id === mid && a.work_date >= today));
      });
    },
    async restore(mid) { await mutate((db) => { Object.assign(find(db, mid), { status: 'active', retired_at: null }); }); },
    async deleteNow(mid) {
      await mutate((db) => {
        db.members = db.members.filter((m) => m.id !== mid);
        db.submissions = db.submissions.filter((s) => s.member_id !== mid);
        db.assignments = db.assignments.filter((a) => a.member_id !== mid);
      });
    },
    async rename(mid, name) { await mutate((db) => { find(db, mid).display_name = name.trim(); }); },
    async joinCode() { return load().joinCode; },
    async rotateJoinCode() {
      // デモでは URL を変えると使えなくなるため、同じコードを返す
      return load().joinCode;
    },
  };
}
