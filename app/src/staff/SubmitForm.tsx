import { useEffect, useMemo, useState } from 'react';
import { friendlyError, staffApi } from '../lib/api';
import { datesBetween, formatDate, formatDateTime, formatRange, weekday } from '../lib/time';
import type { DayEntry, Period } from '../lib/types';
import { ErrorBox, Loading, Segmented, TimeField } from '../ui/components';

type Choice = 'off' | 'on';
interface DayState { choice: Choice | null; start: number | null; end: number | null; note: string; showNote: boolean }
interface FormState { days: Record<string, DayState>; note: string }

const draftKey = (periodId: string) => `cocos-draft-${periodId}`;
const emptyDay = (): DayState => ({ choice: null, start: null, end: null, note: '', showNote: false });

function fromEntries(period: Period, entries: DayEntry[] | null, note: string | null): FormState {
  const byDate = new Map((entries ?? []).map((e) => [e.work_date, e]));
  const days: Record<string, DayState> = {};
  for (const d of datesBetween(period.start_date, period.end_date)) {
    const e = byDate.get(d);
    days[d] = e
      ? { choice: e.is_available ? 'on' : 'off', start: e.start_min, end: e.end_min, note: e.note ?? '', showNote: !!e.note }
      : emptyDay();
  }
  return { days, note: note ?? '' };
}

export function SubmitTab({ periods }: { periods: Period[] }) {
  const open = periods.filter((p) => p.status === 'open');
  const [periodId, setPeriodId] = useState(open[0]?.id ?? '');
  const period = open.find((p) => p.id === periodId);

  if (!open.length) {
    return (
      <div className="page">
        <h1 className="title">シフト提出</h1>
        <div className="card empty">いま受付中の期間はありません。店長から募集の連絡があったら、もう一度開いてください。</div>
      </div>
    );
  }
  return (
    <div className="page">
      <h1 className="title">シフト提出</h1>
      <div className="card">
        <label className="field">
          <span>対象期間</span>
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
            {open.map((p) => (
              <option key={p.id} value={p.id}>{p.label}（{formatDate(p.start_date)}〜{formatDate(p.end_date)}）</option>
            ))}
          </select>
        </label>
        {period?.deadline && <p className="muted small">締切: {formatDateTime(period.deadline)}</p>}
        <p className="muted small">1日は 6:00〜翌2:00 です。深夜0時〜2時は「翌」として選べます。</p>
      </div>
      {period && <PeriodForm key={period.id} period={period} />}
    </div>
  );
}

function PeriodForm({ period }: { period: Period }) {
  const [form, setForm] = useState<FormState | null>(null);
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const dates = useMemo(() => datesBetween(period.start_date, period.end_date), [period]);

  useEffect(() => {
    let alive = true;
    staffApi().mySubmission(period.id).then((s) => {
      if (!alive) return;
      let state = fromEntries(period, s?.days ?? null, s?.note ?? null);
      setSubmittedAt(s?.updated_at ?? null);
      try {
        const draft = localStorage.getItem(draftKey(period.id));
        if (draft) state = { ...state, ...(JSON.parse(draft) as FormState) };
      } catch { /* 下書きが壊れていたら無視 */ }
      setForm(state);
    }).catch((e) => setError(friendlyError(e)));
    return () => { alive = false; };
  }, [period]);

  // 入力途中の内容は端末内にだけ保存する（送信成功で削除）
  useEffect(() => {
    if (!form || done) return;
    try { localStorage.setItem(draftKey(period.id), JSON.stringify(form)); } catch { /* noop */ }
  }, [form, period.id, done]);

  if (error && !form) return <ErrorBox message={error} />;
  if (!form) return <Loading />;

  const setDay = (date: string, patch: Partial<DayState>) =>
    setForm((f) => f && { ...f, days: { ...f.days, [date]: { ...f.days[date], ...patch } } });

  const previousOn = (date: string) => {
    const i = dates.indexOf(date);
    for (let k = i - 1; k >= 0; k--) {
      const d = form.days[dates[k]];
      if (d.choice === 'on' && d.start != null && d.end != null) return d;
    }
    return null;
  };

  const unselected = dates.filter((d) => form.days[d].choice === null).length;

  async function submit() {
    setError(null);
    for (const d of dates) {
      const s = form!.days[d];
      if (s.choice !== 'on') continue;
      if (s.start == null || s.end == null) return setError(`${formatDate(d)} の時間を入力してください`);
      if (s.start >= s.end) return setError(`${formatDate(d)} は終了を開始より後にしてください`);
    }
    if (unselected && !window.confirm(`${unselected}日が未選択です。「休み」として送信しますか？`)) return;
    const days: DayEntry[] = dates.map((d) => {
      const s = form!.days[d];
      const on = s.choice === 'on';
      return { work_date: d, is_available: on, start_min: on ? s.start : null, end_min: on ? s.end : null, note: s.note.trim() || null };
    });
    setBusy(true);
    try {
      await staffApi().submitShift(period.id, form!.note, days);
      if (feedback.trim()) await staffApi().submitFeedback(feedback);
      try { localStorage.removeItem(draftKey(period.id)); } catch { /* noop */ }
      setFeedback('');
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const on = dates.filter((d) => form.days[d].choice === 'on');
    return (
      <div className="card done">
        <div className="done-mark" aria-hidden>✓</div>
        <h2>送信しました</h2>
        <p className="muted">締切までは何度でも修正できます。</p>
        <ul className="summary">
          {on.length === 0 && <li>入れる日はありません</li>}
          {on.map((d) => (
            <li key={d}><span>{formatDate(d)}</span><b>{formatRange(form.days[d].start!, form.days[d].end!)}</b></li>
          ))}
        </ul>
        <button className="btn big" onClick={() => setDone(false)}>内容を修正する</button>
      </div>
    );
  }

  return (
    <>
      {submittedAt && <p className="notice">提出済み（{formatDateTime(submittedAt)}）。修正して送り直せます。</p>}
      {dates.map((date) => {
        const s = form.days[date];
        const wd = weekday(date);
        const prev = s.choice === 'on' ? previousOn(date) : null;
        return (
          <section key={date} className={`card day ${s.choice ?? ''}`}>
            <div className="day-head">
              <h3 className={wd === 0 ? 'sun' : wd === 6 ? 'sat' : ''}>{formatDate(date)}</h3>
              <Segmented<Choice>
                ariaLabel={`${formatDate(date)} の可否`}
                value={s.choice}
                options={[{ value: 'off', label: '休み' }, { value: 'on', label: '入れる' }]}
                onChange={(v) => {
                  const p = v === 'on' && s.start == null ? previousOn(date) : null;
                  setDay(date, p ? { choice: v, start: p.start, end: p.end } : { choice: v });
                }}
              />
            </div>
            <div className={`accordion ${s.choice === 'on' ? 'open' : ''}`}>
              <div className="accordion-inner">
                <div className="time-row">
                  <TimeField label="開始" value={s.start} onChange={(v) => setDay(date, { start: v })} />
                  <span className="time-sep">〜</span>
                  <TimeField label="終了" value={s.end} onChange={(v) => setDay(date, { end: v })} />
                </div>
                {prev && (prev.start !== s.start || prev.end !== s.end) && (
                  <button type="button" className="chip" onClick={() => setDay(date, { start: prev.start, end: prev.end })}>
                    前の日と同じ（{formatRange(prev.start!, prev.end!)}）
                  </button>
                )}
              </div>
            </div>
            {s.showNote ? (
              <input className="day-note" value={s.note} maxLength={200} placeholder="この日の備考（店長だけが見られます）" onChange={(e) => setDay(date, { note: e.target.value })} />
            ) : (
              <button type="button" className="link-btn small" onClick={() => setDay(date, { showNote: true })}>＋ 備考</button>
            )}
          </section>
        );
      })}

      <section className="card">
        <label className="field">
          <span>期間全体の備考（任意）</span>
          <textarea rows={3} maxLength={500} value={form.note} placeholder="例: テスト期間のため週3日まで（店長だけが見られます）" onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </label>
      </section>

      <section className="card feedback-card">
        <label className="field">
          <span>💡 このサイトの改善案を募集</span>
          <textarea rows={3} maxLength={1000} value={feedback} placeholder="使いにくい所、欲しい機能など何でも" onChange={(e) => setFeedback(e.target.value)} />
          <small>名前は記録されません（匿名）。シフトと一緒に送信されます。</small>
        </label>
      </section>

      <ErrorBox message={error} />
      <div className="submit-bar">
        <button className="btn primary big" disabled={busy} onClick={submit}>
          {busy ? '送信中…' : submittedAt ? '修正して送信する' : '送信する'}
        </button>
        {unselected > 0 && <span className="submit-hint">未選択 {unselected}日</span>}
      </div>
    </>
  );
}
