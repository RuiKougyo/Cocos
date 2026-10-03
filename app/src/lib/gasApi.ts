// 無料版: Google Apps Script のウェブアプリ（gas/Code.gs）を呼び出す
import type {
  AdminApi, AdminSignIn, Assignment, BoardRow, DayEntry, Feedback, LoginResult, Member, Period,
  RegisterResult, StaffApi, StaffMe, Submission, TimelineData,
} from './types';

const STAFF_TOKEN = 'cocos-staff-token';
const ADMIN_TOKEN = 'cocos-admin-token';

function getToken(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function setToken(key: string, v: string | null) {
  try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); } catch { /* 保存できなくても続行 */ }
}

export class GasError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON を POST する。Content-Type を text/plain にして CORS のプリフライトを避ける（Apps Script の制約）。
 * 混雑（同時実行の上限・書き込み待ち）のときは少し待って自動で再送する。
 */
async function call<T>(url: string, action: string, params: Record<string, unknown> = {}, token?: string | null): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(600 * 2 ** (attempt - 1) + Math.random() * 400);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: token ?? undefined, ...params }),
        redirect: 'follow',
      });
    } catch (e) {
      lastError = e;
      continue;
    }
    let body: { ok: boolean; data?: T; error?: string; message?: string };
    try {
      body = await res.json();
    } catch {
      // 同時実行の上限を超えると Apps Script は JSON ではなくエラーページを返す
      lastError = new GasError('busy', 'server busy');
      continue;
    }
    if (body.ok) return body.data as T;
    if (body.error === 'busy') { lastError = new GasError('busy', 'server busy'); continue; }
    throw new GasError(body.error ?? 'error', body.message ?? body.error ?? 'error');
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to fetch');
}

export function createGasStaffApi(url: string): StaffApi {
  const staff = <T,>(action: string, params?: Record<string, unknown>) => call<T>(url, action, params, getToken(STAFF_TOKEN));
  return {
    async ensureSession() {},
    async storeByCode(code) {
      const r = await call<{ store_name: string } | null>(url, 'store_info', { code });
      return r ? r.store_name : null;
    },
    async register(code, name, pin) {
      const r = await call<{ result: RegisterResult; token?: string }>(url, 'register', { code, name, pin });
      if (r.token) setToken(STAFF_TOKEN, r.token);
      return r.result;
    },
    async login(code, name, pin) {
      const r = await call<{ result: LoginResult; token?: string }>(url, 'login', { code, name, pin });
      if (r.token) setToken(STAFF_TOKEN, r.token);
      return r.result;
    },
    async logout() {
      try { await staff('logout'); } finally { setToken(STAFF_TOKEN, null); }
    },
    async me() {
      if (!getToken(STAFF_TOKEN)) return null;
      try {
        return await staff<StaffMe>('me');
      } catch (e) {
        // 別の端末でログインした・退職処理された等でトークンが無効
        if (e instanceof GasError && e.code === 'unauthorized') { setToken(STAFF_TOKEN, null); return null; }
        throw e;
      }
    },
    periods: () => staff<Period[]>('periods'),
    mySubmission: (periodId) => staff<Submission | null>('my_submission', { period_id: periodId }),
    async submitShift(periodId, note, days: DayEntry[]) { await staff('submit_shift', { period_id: periodId, note, days }); },
    async submitFeedback(body) { await staff('submit_feedback', { body }); },
    board: (periodId) => staff<BoardRow[]>('board', { period_id: periodId }),
  };
}

export function createGasAdminApi(url: string): AdminApi {
  const admin = <T,>(action: string, params?: Record<string, unknown>) => call<T>(url, action, params, getToken(ADMIN_TOKEN));
  // ログインは「パスワード → 認証コード」の 2 画面。パスワードは認証コードと一緒に送る
  let pendingPassword: string | null = null;
  let pendingSetupCode: string | null = null;

  return {
    loginKind: 'password',
    setupState: () => call<'ready' | 'needs_setup' | 'not_initialized'>(url, 'admin_status'),
    async setupAdmin(setupCode, storeName, password): Promise<AdminSignIn> {
      const r = await call<{ secret: string; otpauth: string }>(url, 'admin_setup', { setup_code: setupCode, store_name: storeName, password });
      pendingSetupCode = setupCode;
      return { next: 'enroll', secret: r.secret, otpauth: r.otpauth };
    },
    async session() {
      if (!getToken(ADMIN_TOKEN)) return 'none';
      try {
        await admin('admin_me');
        return 'ok';
      } catch (e) {
        if (e instanceof GasError && e.code === 'unauthorized') { setToken(ADMIN_TOKEN, null); return 'none'; }
        throw e;
      }
    },
    async signIn(_email, password) {
      pendingPassword = password;
      return { next: 'mfa' };
    },
    async verifyMfa(code) {
      const r = pendingSetupCode
        ? await call<{ token: string }>(url, 'admin_setup_verify', { setup_code: pendingSetupCode, totp: code })
        : await call<{ token: string }>(url, 'admin_login', { password: pendingPassword, totp: code });
      pendingSetupCode = null;
      pendingPassword = null;
      setToken(ADMIN_TOKEN, r.token);
    },
    async signOut() {
      try { await admin('admin_logout'); } catch { /* 期限切れでもログアウト扱い */ }
      setToken(ADMIN_TOKEN, null);
      pendingPassword = null;
    },
    async me() {
      const r = await admin<{ store_name: string }>('admin_me');
      return { member_id: 'admin', display_name: '店長', store_id: 'store', store_name: r.store_name };
    },
    async createStore() {
      throw new Error('setup is done with setupAdmin');
    },

    periods: () => admin<Period[]>('admin_periods'),
    async createPeriod(p) { await admin('create_period', p); },
    async setPeriodStatus(id, status) { await admin('set_period_status', { period_id: id, status }); },
    async deletePeriod(id) { await admin('delete_period', { period_id: id }); },

    timeline: (periodId) => admin<TimelineData>('timeline', { period_id: periodId }),
    async setAssignment(periodId, a: Assignment) { await admin('set_assignment', { period_id: periodId, ...a }); },
    async removeAssignment(memberId, workDate) { await admin('remove_assignment', { member_id: memberId, work_date: workDate }); },
    unsubmitted: (periodId) => admin<{ member_id: string; display_name: string }[]>('unsubmitted', { period_id: periodId }),
    feedback: () => admin<Feedback[]>('feedback'),

    members: () => admin<Member[]>('members'),
    async approve(id) { await admin('approve', { member_id: id }); },
    async reject(id) { await admin('reject', { member_id: id }); },
    async resetLogin(id) { await admin('reset_login', { member_id: id }); },
    async retire(id) { await admin('retire', { member_id: id }); },
    async restore(id) { await admin('restore', { member_id: id }); },
    async deleteNow(id) { await admin('delete_now', { member_id: id }); },
    async rename(id, name) { await admin('rename', { member_id: id, name }); },
    joinCode: () => admin<string>('join_code'),
    rotateJoinCode: () => admin<string>('rotate_join_code'),
  };
}
