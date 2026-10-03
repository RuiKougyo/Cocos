import { createDemoAdminApi, createDemoStaffApi } from './demoApi';
import { createSupabaseAdminApi, createSupabaseStaffApi } from './supabaseApi';
import type { AdminApi, StaffApi } from './types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isDemo = !url || !key;
export const turnstileSiteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || null;

let staff: StaffApi | null = null;
let admin: AdminApi | null = null;

export function staffApi(): StaffApi {
  return (staff ??= isDemo ? createDemoStaffApi() : createSupabaseStaffApi(url!, key!));
}
export function adminApi(): AdminApi {
  return (admin ??= isDemo ? createDemoAdminApi() : createSupabaseAdminApi(url!, key!));
}

/** DB のエラーを利用者向けの文に置き換える */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not accepting/.test(msg)) return 'この期間は受付を締め切りました。';
  if (/invalid day|invalid time|check constraint/.test(msg)) return '入力内容に誤りがあります。時間を確認してください。';
  if (/required|permission|42501/.test(msg)) return '権限がありません。もう一度開き直してください。';
  if (/Failed to fetch|NetworkError/.test(msg)) return '通信できませんでした。電波の良い所でもう一度お試しください。';
  if (/Invalid login credentials/.test(msg)) return 'メールアドレスまたはパスワードが違います。';
  if (/Invalid TOTP|invalid.*code/i.test(msg)) return '認証コードが違います。';
  return msg;
}
