import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AdminApi, AdminMe, Assignment, BoardRow, DayEntry, Feedback, LoginResult, Member, Period,
  RegisterResult, StaffApi, StaffMe, Submission, TimelineData,
} from './types';

const MEMBER_COLS = 'id, display_name, role, status, sort_order, created_at, approved_at, retired_at, locked_until';
const SUBMISSION_COLS = 'member_id, note, updated_at, days:submission_days(work_date, is_available, start_min, end_min, note)';

// エラーなら例外にする。maybeSingle の結果など NULL があり得る箇所は呼び出し側で `| null` に型付けする
function check<R extends { data: unknown; error: { message: string } | null }>(res: R): NonNullable<R['data']> {
  if (res.error) throw new Error(res.error.message);
  return res.data as NonNullable<R['data']>;
}

// スタッフと店長は別のセッション保存領域を使う（同じ端末で両方使っても混ざらない）
function client(url: string, key: string, storageKey: string): SupabaseClient {
  return createClient(url, key, {
    auth: { storageKey, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}

async function uid(sb: SupabaseClient): Promise<string | null> {
  const { data } = await sb.auth.getSession();
  return data.session?.user.id ?? null;
}

export function createSupabaseStaffApi(url: string, key: string): StaffApi {
  const sb = client(url, key, 'cocos-staff');
  return {
    async ensureSession(captchaToken) {
      if (await uid(sb)) return;
      const { error } = await sb.auth.signInAnonymously({ options: { captchaToken } });
      if (error) throw new Error(error.message);
    },
    async storeByCode(code) {
      const rows = check(await sb.rpc('store_by_code', { p_code: code })) as { store_name: string }[];
      return rows[0]?.store_name ?? null;
    },
    async register(code, name, pin) {
      return check(await sb.rpc('register_member', { p_code: code, p_display_name: name, p_pin: pin })) as RegisterResult;
    },
    async login(code, name, pin) {
      return check(await sb.rpc('login_member', { p_code: code, p_display_name: name, p_pin: pin })) as LoginResult;
    },
    async logout() {
      check(await sb.rpc('logout_member'));
      await sb.auth.signOut();
    },
    async me(): Promise<StaffMe | null> {
      const id = await uid(sb);
      if (!id) return null;
      const m = check(
        await sb.from('members').select('id, display_name, status, store_id').eq('user_id', id).maybeSingle(),
      ) as { id: string; display_name: string; status: StaffMe['status']; store_id: string } | null;
      if (!m) return null;
      // 店舗名は承認後にだけ読める（承認待ちの間は URL のコードから引く）
      const store = check(await sb.from('stores').select('name').eq('id', m.store_id).maybeSingle()) as { name: string } | null;
      return { member_id: m.id, display_name: m.display_name, status: m.status, store_name: store?.name ?? '' };
    },
    async periods() {
      return check(
        await sb.from('shift_periods').select('*').neq('status', 'draft').order('start_date', { ascending: false }),
      ) as Period[];
    },
    async mySubmission(periodId) {
      return check(
        await sb.from('submissions').select(SUBMISSION_COLS).eq('period_id', periodId).maybeSingle(),
      ) as Submission | null;
    },
    async submitShift(periodId, note, days: DayEntry[]) {
      check(await sb.rpc('submit_shift', { p_period_id: periodId, p_note: note, p_days: days }));
    },
    async submitFeedback(body) {
      check(await sb.rpc('submit_feedback', { p_body: body }));
    },
    async board(periodId) {
      return check(await sb.rpc('availability_board', { p_period_id: periodId })) as BoardRow[];
    },
  };
}

export function createSupabaseAdminApi(url: string, key: string): AdminApi {
  const sb = client(url, key, 'cocos-admin');
  let factorId: string | null = null;
  let meCache: AdminMe | null = null;

  async function storeId(): Promise<string> {
    const me = meCache ?? (await api.me());
    if (!me) throw new Error('store not found');
    return me.store_id;
  }

  const api: AdminApi = {
    async session() {
      if (!(await uid(sb))) return 'none';
      const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      if (data?.currentLevel === 'aal2') return 'ok';
      const factors = check(await sb.auth.mfa.listFactors());
      factorId = factors.totp[0]?.id ?? null;
      return factorId ? 'mfa' : 'none';
    },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }));
      const factors = check(await sb.auth.mfa.listFactors());
      const verified = factors.totp.find((f) => f.status === 'verified');
      if (verified) {
        factorId = verified.id;
        return { next: 'mfa' };
      }
      // 初回: 認証アプリを登録
      const enrolled = check(await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `cocos-${Date.now()}` }));
      factorId = enrolled.id;
      return { next: 'enroll', qr: enrolled.totp.qr_code, secret: enrolled.totp.secret };
    },
    async verifyMfa(code) {
      if (!factorId) throw new Error('no MFA factor');
      check(await sb.auth.mfa.challengeAndVerify({ factorId, code }));
    },
    async signOut() {
      meCache = null;
      await sb.auth.signOut();
    },
    async me() {
      const id = await uid(sb);
      if (!id) return null;
      const m = check(
        await sb.from('members').select('id, display_name, store_id').eq('user_id', id).eq('role', 'admin').maybeSingle(),
      ) as { id: string; display_name: string; store_id: string } | null;
      if (!m) return null;
      const s = check(await sb.from('stores').select('name').eq('id', m.store_id).single()) as { name: string };
      meCache = { member_id: m.id, display_name: m.display_name, store_id: m.store_id, store_name: s.name };
      return meCache;
    },
    async createStore(storeName, displayName) {
      check(await sb.rpc('create_store', { p_store_name: storeName, p_admin_display_name: displayName }));
    },

    async periods() {
      return check(await sb.from('shift_periods').select('*').order('start_date', { ascending: false })) as Period[];
    },
    async createPeriod(p) {
      check(await sb.from('shift_periods').insert({ ...p, store_id: await storeId(), status: 'draft' }));
    },
    async setPeriodStatus(id, status) {
      check(await sb.from('shift_periods').update({ status }).eq('id', id));
    },
    async deletePeriod(id) {
      check(await sb.from('shift_periods').delete().eq('id', id));
    },

    async timeline(periodId): Promise<TimelineData> {
      const [members, submissions, assignments] = await Promise.all([
        sb.from('members').select(MEMBER_COLS).eq('role', 'staff').eq('status', 'active').order('sort_order'),
        sb.from('submissions').select(SUBMISSION_COLS).eq('period_id', periodId),
        sb.from('shift_assignments').select('member_id, work_date, start_min, end_min').eq('period_id', periodId),
      ]);
      return {
        members: check(members) as Member[],
        submissions: check(submissions) as Submission[],
        assignments: check(assignments) as Assignment[],
      };
    },
    async setAssignment(periodId, a) {
      check(await sb.from('shift_assignments').upsert({ ...a, period_id: periodId, updated_at: new Date().toISOString() }, { onConflict: 'member_id,work_date' }));
    },
    async removeAssignment(memberId, workDate) {
      check(await sb.from('shift_assignments').delete().eq('member_id', memberId).eq('work_date', workDate));
    },
    async unsubmitted(periodId) {
      return check(await sb.rpc('unsubmitted_members', { p_period_id: periodId })) as { member_id: string; display_name: string }[];
    },
    async feedback() {
      return check(await sb.from('feedback').select('id, body, created_at').order('created_at', { ascending: false })) as Feedback[];
    },

    async members() {
      return check(await sb.from('members').select(MEMBER_COLS).eq('role', 'staff').order('sort_order')) as Member[];
    },
    async approve(id) { check(await sb.rpc('approve_member', { p_member_id: id })); },
    async reject(id) { check(await sb.rpc('reject_member', { p_member_id: id })); },
    async resetLogin(id) { check(await sb.rpc('reset_member_login', { p_member_id: id })); },
    async retire(id) { check(await sb.rpc('retire_member', { p_member_id: id })); },
    async restore(id) { check(await sb.rpc('restore_member', { p_member_id: id })); },
    async deleteNow(id) { check(await sb.rpc('delete_member_now', { p_member_id: id })); },
    async rename(id, name) { check(await sb.from('members').update({ display_name: name.trim() }).eq('id', id)); },
    async joinCode() {
      return (check(await sb.from('store_join_codes').select('code').single()) as { code: string }).code;
    },
    async rotateJoinCode() {
      return check(await sb.rpc('rotate_join_code')) as string;
    },
  };
  return api;
}
