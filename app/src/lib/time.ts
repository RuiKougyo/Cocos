// 営業日は 06:00〜翌 02:00。時刻は「営業日 0:00 からの分」で扱う（DB と同じ）。
export const DAY_START = 6 * 60; // 360
export const DAY_END = 26 * 60; // 1560 = 翌 02:00
export const STEP = 5;

/** 1530 → "1:30"（翌日かどうかは含めない。<input type="time"> 用は toInputValue） */
function hm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** 表示用: 1025 → "17:05", 1530 → "翌1:30" */
export function formatMin(min: number): string {
  return (min >= 1440 ? '翌' : '') + hm(min);
}

export function formatRange(start: number, end: number): string {
  return `${formatMin(start)}〜${formatMin(end)}`;
}

/** <input type="time"> の value 形式（"HH:MM"） */
export function toInputValue(min: number | null): string {
  if (min == null) return '';
  const m = min % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export type ParsedTime =
  | { ok: true; min: number; rounded: boolean }
  | { ok: false; error: string };

/**
 * ピッカーの "HH:MM" を営業日の分に変換する。
 * 06:00 より前は翌日とみなす。5 分刻みに丸める（iOS は step を無視するため）。
 */
export function parsePickerValue(value: string): ParsedTime {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return { ok: false, error: '時刻を入力してください' };
  const raw = Number(m[1]) * 60 + Number(m[2]);
  const roundedClock = Math.round(raw / STEP) * STEP;
  let min = roundedClock % 1440;
  if (min < DAY_START) min += 1440;
  if (min < DAY_START || min > DAY_END) {
    return { ok: false, error: '翌2:00〜6:00 は選べません' };
  }
  return { ok: true, min, rounded: roundedClock !== raw };
}

// ---- 日付（"YYYY-MM-DD" 文字列で扱い、タイムゾーンの影響を受けないよう UTC で計算） ----
function toUtc(date: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d));
}
function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export function weekday(date: string): number {
  return toUtc(date).getUTCDay();
}
/** "2026-10-03" → "10/3(土)" */
export function formatDate(date: string): string {
  const d = toUtc(date);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEK[d.getUTCDay()]})`;
}

/** いまの営業日（06:00 前は前日扱い） */
export function businessToday(now = new Date()): string {
  const local = new Date(now.getTime() - DAY_START * 60_000);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const d = String(local.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 2 区間の重なり（なければ null） */
export function overlap(a0: number, a1: number, b0: number, b1: number): [number, number] | null {
  const s = Math.max(a0, b0);
  const e = Math.min(a1, b1);
  return s < e ? [s, e] : null;
}
