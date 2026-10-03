import { createDemoAdminApi, createDemoStaffApi } from './demoApi';
import { createGasAdminApi, createGasStaffApi } from './gasApi';
import { createSupabaseAdminApi, createSupabaseStaffApi } from './supabaseApi';
import type { AdminApi, StaffApi } from './types';

const env = import.meta.env;
const gasUrl = env.VITE_GAS_URL as string | undefined;
const sbUrl = env.VITE_SUPABASE_URL as string | undefined;
const sbKey = env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** 接続先: gas（無料版: Google スプレッドシート）／ supabase（有料版）／ demo（ブラウザ内のみ） */
export const backend: 'gas' | 'supabase' | 'demo' =
  (env.VITE_BACKEND as 'gas' | 'supabase' | undefined) ?? (gasUrl ? 'gas' : sbUrl && sbKey ? 'supabase' : 'demo');
export const isDemo = backend === 'demo';
export const turnstileSiteKey = backend === 'supabase' ? (env.VITE_TURNSTILE_SITE_KEY as string | undefined) || null : null;

let staff: StaffApi | null = null;
let admin: AdminApi | null = null;

export function staffApi(): StaffApi {
  if (!staff) {
    staff = backend === 'gas' ? createGasStaffApi(gasUrl!)
      : backend === 'supabase' ? createSupabaseStaffApi(sbUrl!, sbKey!)
      : createDemoStaffApi();
  }
  return staff;
}
export function adminApi(): AdminApi {
  if (!admin) {
    admin = backend === 'gas' ? createGasAdminApi(gasUrl!)
      : backend === 'supabase' ? createSupabaseAdminApi(sbUrl!, sbKey!)
      : createDemoAdminApi();
  }
  return admin;
}

/** サーバーのエラーを利用者向けの文に置き換える */
export function friendlyError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  const byCode: Record<string, string> = {
    closed: 'この期間は受付を締め切りました。',
    invalid: '入力内容に誤りがあります。時間や日付を確認してください。',
    unauthorized: 'ログインの有効期限が切れました。もう一度ログインしてください。',
    forbidden: 'この操作はできません。',
    busy: '混み合っています。少し待ってからもう一度お試しください。',
    name_taken: '同じ表示名の人がすでにいます。',
    invalid_login: 'パスワードまたは認証コードが違います。',
    invalid_totp: '認証コードが違います。認証アプリに表示された最新のコードを入力してください。',
    invalid_setup_code: '初期設定コードが違います。',
    weak_password: 'パスワードは10文字以上にしてください。',
    locked: '失敗が続いたため一時的にロックしました。15分ほど待ってからお試しください。',
    not_initialized: 'スプレッドシートの初期設定（initialize）がまだです。',
  };
  if (code && byCode[code]) return byCode[code];
  if (/not accepting/.test(msg)) return byCode.closed;
  if (/invalid day|invalid time|check constraint/.test(msg)) return byCode.invalid;
  if (/required|permission|42501/.test(msg)) return '権限がありません。もう一度開き直してください。';
  if (/Failed to fetch|NetworkError|Load failed/.test(msg)) return '通信できませんでした。電波の良い所でもう一度お試しください。';
  if (/Invalid login credentials/.test(msg)) return 'メールアドレスまたはパスワードが違います。';
  if (/Invalid TOTP|invalid.*code/i.test(msg)) return '認証コードが違います。';
  return msg;
}
