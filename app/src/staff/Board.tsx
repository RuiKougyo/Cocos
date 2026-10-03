import { useEffect, useMemo, useState } from 'react';
import { friendlyError, staffApi } from '../lib/api';
import { addDays, businessToday, formatDate, formatMin, formatRange, overlap, weekday } from '../lib/time';
import type { BoardRow, Period } from '../lib/types';
import { ErrorBox, Loading } from '../ui/components';

export function useBoard(periodId: string) {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!periodId) return;
    let alive = true;
    setRows(null);
    staffApi().board(periodId).then((r) => alive && setRows(r)).catch((e) => alive && setError(friendlyError(e)));
    return () => { alive = false; };
  }, [periodId]);
  return { rows, error };
}

export function defaultPeriod(periods: Period[]): Period | undefined {
  const today = businessToday();
  return periods.find((p) => p.start_date <= today && today <= p.end_date) ?? periods.find((p) => p.status === 'open') ?? periods[0];
}

export function BoardTab({ periods }: { periods: Period[] }) {
  const [periodId, setPeriodId] = useState(defaultPeriod(periods)?.id ?? '');
  const period = periods.find((p) => p.id === periodId);
  const { rows, error } = useBoard(periodId);
  const [date, setDate] = useState('');

  useEffect(() => {
    if (!period) return;
    const t = businessToday();
    setDate(t < period.start_date ? period.start_date : t > period.end_date ? period.end_date : t);
  }, [period]);

  const day = useMemo(() => (rows ?? []).filter((r) => r.work_date === date), [rows, date]);

  if (!period) {
    return (
      <div className="page">
        <h1 className="title">代わりを探す</h1>
        <div className="card empty">表示できる期間がありません。</div>
      </div>
    );
  }

  const me = day.find((r) => r.is_me);
  const myShift = me?.assign_start != null ? ([me.assign_start, me.assign_end!] as const) : null;
  const working = day.filter((r) => r.assign_start != null).sort((a, b) => a.assign_start! - b.assign_start!);
  const candidates = day
    .filter((r) => !r.is_me && r.avail_start != null && r.assign_start == null)
    .map((r) => ({ r, ov: myShift ? overlap(myShift[0], myShift[1], r.avail_start!, r.avail_end!) : null }))
    .sort((a, b) => {
      const la = a.ov ? a.ov[1] - a.ov[0] : -1;
      const lb = b.ov ? b.ov[1] - b.ov[0] : -1;
      return lb - la || a.r.avail_start! - b.r.avail_start!;
    });
  // 確定より長く入れる人（延長をお願いできる人）
  const extendable = working.filter((r) => !r.is_me && r.avail_start != null && (r.avail_start < r.assign_start! || r.avail_end! > r.assign_end!));
  const wd = weekday(date);

  return (
    <div className="page">
      <h1 className="title">代わりを探す</h1>
      <div className="card">
        <label className="field">
          <span>期間</span>
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
            {periods.map((p) => <option key={p.id} value={p.id}>{p.label}{p.status === 'open' ? '（受付中）' : ''}</option>)}
          </select>
        </label>
        <div className="date-nav">
          <button className="icon-btn" aria-label="前の日" disabled={date <= period.start_date} onClick={() => setDate(addDays(date, -1))}>‹</button>
          <strong className={wd === 0 ? 'sun' : wd === 6 ? 'sat' : ''}>{date && formatDate(date)}</strong>
          <button className="icon-btn" aria-label="次の日" disabled={date >= period.end_date} onClick={() => setDate(addDays(date, 1))}>›</button>
        </div>
      </div>

      <ErrorBox message={error} />
      {!rows ? <Loading /> : (
        <>
          <div className={`card my-shift ${myShift ? 'has' : ''}`}>
            {myShift
              ? <>あなたの出勤: <b>{formatRange(myShift[0], myShift[1])}</b></>
              : <span className="muted">この日のあなたの確定シフトはありません</span>}
          </div>

          <section className="card">
            <h2 className="section-title">代わりに出られる人 <span className="count">{candidates.length}</span></h2>
            <p className="muted small">「入れる」と提出していて、まだシフトに入っていない人です。</p>
            {candidates.length === 0 && <p className="empty-line">いません</p>}
            <ul className="people">
              {candidates.map(({ r, ov }) => (
                <li key={r.member_id}>
                  <span className="person">{r.display_name}</span>
                  <span className="range avail">{formatRange(r.avail_start!, r.avail_end!)}</span>
                  {myShift && (
                    <span className={`overlap ${ov ? (ov[0] === myShift[0] && ov[1] === myShift[1] ? 'full' : 'part') : 'none'}`}>
                      {ov
                        ? ov[0] === myShift[0] && ov[1] === myShift[1] ? 'あなたの時間をすべてカバー' : `${formatRange(ov[0], ov[1])} が重なる`
                        : 'あなたの時間とは重ならない'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {extendable.length > 0 && (
              <>
                <h3 className="sub-title">確定より長く入れる人</h3>
                <ul className="people">
                  {extendable.map((r) => (
                    <li key={r.member_id}>
                      <span className="person">{r.display_name}</span>
                      <span className="range">確定 {formatRange(r.assign_start!, r.assign_end!)}</span>
                      <span className="overlap part">
                        {r.avail_start! < r.assign_start! && `${formatMin(r.avail_start!)}から`}
                        {r.avail_start! < r.assign_start! && r.avail_end! > r.assign_end! && '・'}
                        {r.avail_end! > r.assign_end! && `${formatMin(r.avail_end!)}まで`}可
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="card">
            <h2 className="section-title">出勤予定 <span className="count">{working.length}</span></h2>
            {working.length === 0 && <p className="empty-line">まだ確定していません</p>}
            <ul className="people">
              {working.map((r) => (
                <li key={r.member_id}>
                  <span className="person">{r.display_name}{r.is_me && <em>（あなた）</em>}</span>
                  <span className="range assigned">{formatRange(r.assign_start!, r.assign_end!)}</span>
                </li>
              ))}
            </ul>
          </section>
          <p className="fine">表示されるのは名前と時間帯だけです。備考や「休み」の理由は店長しか見られません。連絡はいつものグループチャットでどうぞ。</p>
        </>
      )}
    </div>
  );
}
