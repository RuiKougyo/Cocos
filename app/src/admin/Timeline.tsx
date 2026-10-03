import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { adminApi, friendlyError } from '../lib/api';
import { addDays, businessToday, formatDate, formatMin, formatRange, weekday } from '../lib/time';
import type { DayEntry, Member, Period, TimelineData } from '../lib/types';
import { ErrorBox, Loading, Sheet, TimeField, toast } from '../ui/components';

const TIME_COL = 46;
const HEAD_H = 34;
const MIN_PPM = 0.3; // 1 分あたりのピクセル数
const MAX_PPM = 6;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const colWidth = (ppm: number) => Math.round(clamp(40 + 26 * ppm, 52, 120));

function gridSteps(ppm: number): { line: number; label: number } {
  if (ppm >= 4.5) return { line: 5, label: 15 };
  if (ppm >= 2.4) return { line: 15, label: 30 };
  if (ppm >= 1.2) return { line: 30, label: 60 };
  return { line: 60, label: 60 };
}

interface Cell { member: Member; date: string }

export function TimelineTab({ period, storeName }: { period: Period; storeName: string }) {
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(() => {
    const t = businessToday();
    return t < period.start_date || t > period.end_date ? period.start_date : t;
  });
  const [ppm, setPpm] = useState(0.8);
  const [shot, setShot] = useState(false);
  const [cell, setCell] = useState<Cell | null>(null);

  const reload = () => adminApi().timeline(period.id).then(setData).catch((e) => setError(friendlyError(e)));
  useEffect(() => { setData(null); void reload(); }, [period.id]);

  const index = useMemo(() => {
    const avail = new Map<string, DayEntry>();
    const notes = new Map<string, string | null>();
    const assign = new Map<string, { start_min: number; end_min: number }>();
    for (const s of data?.submissions ?? []) {
      notes.set(s.member_id, s.note);
      for (const d of s.days) avail.set(`${s.member_id}|${d.work_date}`, d);
    }
    for (const a of data?.assignments ?? []) assign.set(`${a.member_id}|${a.work_date}`, a);
    return { avail, notes, assign };
  }, [data]);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const counts = data.members.reduce(
    (acc, m) => {
      if (index.assign.has(`${m.id}|${date}`)) acc.assigned++;
      if (index.avail.get(`${m.id}|${date}`)?.is_available) acc.avail++;
      return acc;
    },
    { assigned: 0, avail: 0 },
  );
  const wd = weekday(date);

  return (
    <div className="tl-page">
      <div className="tl-toolbar">
        <button className="icon-btn" aria-label="前の日" disabled={date <= period.start_date} onClick={() => setDate(addDays(date, -1))}>‹</button>
        <div className="tl-date">
          <strong className={wd === 0 ? 'sun' : wd === 6 ? 'sat' : ''}>{formatDate(date)}</strong>
          <small>確定 {counts.assigned}人 / 希望 {counts.avail}人</small>
        </div>
        <button className="icon-btn" aria-label="次の日" disabled={date >= period.end_date} onClick={() => setDate(addDays(date, 1))}>›</button>
        <span className="spacer" />
        <button className="icon-btn" aria-label="縮小" onClick={() => setPpm((p) => clamp(p / 1.4, MIN_PPM, MAX_PPM))}>−</button>
        <button className="icon-btn" aria-label="拡大" onClick={() => setPpm((p) => clamp(p * 1.4, MIN_PPM, MAX_PPM))}>＋</button>
        <button className="icon-btn" aria-label="スクショモード" onClick={() => setShot(true)}>📷</button>
      </div>
      <div className="tl-legend">
        <span><i className="lg avail" />希望</span>
        <span><i className="lg assigned" />確定</span>
        <span><i className="lg off" />休み</span>
        <span><i className="lg none" />未提出</span>
        <span className="muted">ピンチで拡大・縮小／バーをタップで確定</span>
      </div>
      <Grid
        members={data.members}
        date={date}
        period={period}
        ppm={ppm}
        onZoom={setPpm}
        index={index}
        onCell={setCell}
      />
      {shot && <ShotMode members={data.members} date={date} period={period} index={index} storeName={storeName} onClose={() => setShot(false)} />}
      {cell && (
        <CellSheet
          cell={cell}
          period={period}
          day={index.avail.get(`${cell.member.id}|${cell.date}`)}
          submitted={index.notes.has(cell.member.id)}
          overallNote={index.notes.get(cell.member.id) ?? null}
          assignment={index.assign.get(`${cell.member.id}|${cell.date}`)}
          onClose={() => setCell(null)}
          onSaved={() => { setCell(null); void reload(); }}
        />
      )}
    </div>
  );
}

type Index = {
  avail: Map<string, DayEntry>;
  notes: Map<string, string | null>;
  assign: Map<string, { start_min: number; end_min: number }>;
};

function Grid(props: {
  members: Member[]; date: string; period: Period; ppm: number; index: Index;
  onZoom?: (ppm: number) => void; onCell?: (c: Cell) => void; fixedColW?: number; compact?: boolean;
}) {
  const { members, date, period, ppm, index } = props;
  const v0 = period.view_start_min;
  const v1 = period.view_end_min;
  const colW = props.fixedColW ?? colWidth(ppm);
  const bodyH = (v1 - v0) * ppm;
  const scroller = useRef<HTMLDivElement>(null);
  const pending = useRef<{ minute: number; y: number } | null>(null);
  const ppmRef = useRef(ppm);
  ppmRef.current = ppm;

  // ピンチ操作（2 本指の距離の比で倍率を変え、指の中心の時刻が動かないようにスクロールを補正）
  useEffect(() => {
    const el = scroller.current;
    if (!el || !props.onZoom) return;
    let start: { dist: number; ppm: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) start = { dist: dist(e.touches), ppm: ppmRef.current };
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !start) return;
      e.preventDefault();
      const next = clamp(start.ppm * (dist(e.touches) / start.dist), MIN_PPM, MAX_PPM);
      const rect = el.getBoundingClientRect();
      const y = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      pending.current = { minute: (el.scrollTop + y - HEAD_H) / ppmRef.current, y };
      ppmRef.current = next;
      props.onZoom!(next);
    };
    const onEnd = (e: TouchEvent) => { if (e.touches.length < 2) start = null; };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // トラックパッドのピンチ（PC での確認用）
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const y = e.clientY - rect.top;
      pending.current = { minute: (el.scrollTop + y - HEAD_H) / ppmRef.current, y };
      ppmRef.current = clamp(ppmRef.current * Math.exp(-e.deltaY / 200), MIN_PPM, MAX_PPM);
      props.onZoom!(ppmRef.current);
    };
    const stopGesture = (e: Event) => e.preventDefault(); // iOS Safari のページ拡大を抑止
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', stopGesture);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', stopGesture);
    };
  }, [props.onZoom]);

  // 日付を切り替えたら、その日のいちばん早いバーが見える位置までスクロールする
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || props.compact) return;
    let first = Infinity;
    for (const m of members) {
      const d = index.avail.get(`${m.id}|${date}`);
      const a = index.assign.get(`${m.id}|${date}`);
      if (d?.is_available && d.start_min != null) first = Math.min(first, d.start_min);
      if (a) first = Math.min(first, a.start_min);
    }
    el.scrollTop = first === Infinity ? 0 : Math.max(0, (first - 30 - v0) * ppmRef.current);
  }, [date, members]); // ppm の変化ではスクロールし直さない

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pending.current) {
      el.scrollTop = pending.current.minute * ppm + HEAD_H - pending.current.y;
      pending.current = null;
    }
  }, [ppm]);

  const steps = gridSteps(ppm);
  const lines: number[] = [];
  for (let m = Math.ceil(v0 / steps.line) * steps.line; m <= v1; m += steps.line) lines.push(m);
  const y = (m: number) => (m - v0) * ppm;

  return (
    <div className={`tl-scroll ${props.compact ? 'compact' : ''}`} ref={scroller}>
      <div className="tl-canvas" style={{ width: TIME_COL + members.length * colW, height: HEAD_H + bodyH }}>
        <div className="tl-head" style={{ height: HEAD_H }}>
          <div className="tl-corner" style={{ width: TIME_COL }} />
          {members.map((m) => (
            <div key={m.id} className="tl-name" style={{ width: colW }} title={m.display_name}>{m.display_name}</div>
          ))}
        </div>
        <div className="tl-body" style={{ height: bodyH }}>
          <div className="tl-times" style={{ width: TIME_COL }}>
            {lines.filter((m) => m % steps.label === 0).map((m) => (
              <span key={m} className={`tl-time ${m % 60 === 0 ? 'hour' : ''}`} style={{ top: y(m) }}>{formatMin(m)}</span>
            ))}
          </div>
          <div className="tl-lines" style={{ left: TIME_COL }}>
            {lines.map((m) => <div key={m} className={`tl-line ${m % 60 === 0 ? 'hour' : ''} ${m === 1440 ? 'midnight' : ''}`} style={{ top: y(m) }} />)}
          </div>
          {members.map((m, i) => {
            const key = `${m.id}|${date}`;
            const day = index.avail.get(key);
            const asg = index.assign.get(key);
            const submitted = index.notes.has(m.id);
            const left = TIME_COL + i * colW;
            const open = () => props.onCell?.({ member: m, date });
            return (
              <div key={m.id} className={`tl-col ${!submitted ? 'unsubmitted' : day && !day.is_available ? 'off' : ''}`} style={{ left, width: colW }} onClick={open}>
                {!submitted && <span className="tl-col-label">未提出</span>}
                {submitted && day && !day.is_available && <span className="tl-col-label">休み</span>}
                {day?.is_available && day.start_min != null && (
                  <div className="tl-bar avail" style={{ top: y(day.start_min), height: (day.end_min! - day.start_min) * ppm }}>
                    {!asg && <span className="tl-bar-text">{formatMin(day.start_min)}<br />{formatMin(day.end_min!)}</span>}
                    {day.note && <span className="tl-note" aria-label="備考あり">💬</span>}
                  </div>
                )}
                {asg && (
                  <div className="tl-bar assigned" style={{ top: y(asg.start_min), height: (asg.end_min - asg.start_min) * ppm }}>
                    <span className="tl-bar-text">{formatMin(asg.start_min)}<br />{formatMin(asg.end_min)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ShotMode(props: { members: Member[]; date: string; period: Period; index: Index; storeName: string; onClose: () => void }) {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [chrome, setChrome] = useState(true);
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    const t = setTimeout(() => setChrome(false), 2500);
    return () => { window.removeEventListener('resize', on); clearTimeout(t); };
  }, []);
  const range = props.period.view_end_min - props.period.view_start_min;
  const ppm = (size.h - 64 - HEAD_H - 8) / range;
  const colW = Math.max(30, Math.floor((size.w - TIME_COL - 4) / Math.max(1, props.members.length)));
  const now = new Date();
  return (
    <div className="shot" onClick={() => setChrome(true)}>
      <div className="shot-head">
        <strong>{props.storeName} {formatDate(props.date)} シフト</strong>
        <small>{now.getMonth() + 1}/{now.getDate()} {now.getHours()}:{String(now.getMinutes()).padStart(2, '0')} 時点 ／ 濃い色=確定・薄い色=入れる</small>
      </div>
      <Grid members={props.members} date={props.date} period={props.period} ppm={ppm} index={props.index} fixedColW={colW} compact />
      {chrome && <button className="shot-close" onClick={(e) => { e.stopPropagation(); props.onClose(); }}>閉じる</button>}
    </div>
  );
}

function CellSheet(props: {
  cell: Cell; period: Period; day?: DayEntry; submitted: boolean; overallNote: string | null;
  assignment?: { start_min: number; end_min: number }; onClose: () => void; onSaved: () => void;
}) {
  const { cell, day, assignment } = props;
  const [start, setStart] = useState<number | null>(assignment?.start_min ?? day?.start_min ?? null);
  const [end, setEnd] = useState<number | null>(assignment?.end_min ?? day?.end_min ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (start == null || end == null || start >= end) return setError('開始と終了を正しく入力してください');
    setBusy(true);
    try {
      await adminApi().setAssignment(props.period.id, { member_id: cell.member.id, work_date: cell.date, start_min: start, end_min: end });
      toast('確定しました');
      props.onSaved();
    } catch (e) { setError(friendlyError(e)); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try {
      await adminApi().removeAssignment(cell.member.id, cell.date);
      toast('確定を外しました');
      props.onSaved();
    } catch (e) { setError(friendlyError(e)); } finally { setBusy(false); }
  }

  return (
    <Sheet title={`${cell.member.display_name}　${formatDate(cell.date)}`} onClose={props.onClose}>
      <dl className="kv">
        <dt>希望</dt>
        <dd>{!props.submitted ? '未提出' : day?.is_available ? formatRange(day.start_min!, day.end_min!) : '休み'}</dd>
        {day?.note && <><dt>この日の備考</dt><dd>{day.note}</dd></>}
        {props.overallNote && <><dt>期間の備考</dt><dd>{props.overallNote}</dd></>}
        <dt>確定</dt>
        <dd>{assignment ? formatRange(assignment.start_min, assignment.end_min) : 'なし'}</dd>
      </dl>
      <div className="time-row">
        <TimeField label="開始" value={start} onChange={setStart} />
        <span className="time-sep">〜</span>
        <TimeField label="終了" value={end} onChange={setEnd} />
      </div>
      <ErrorBox message={error} />
      <div className="stack">
        <button className="btn primary big" disabled={busy} onClick={save}>{assignment ? '確定シフトを更新' : 'この時間で確定'}</button>
        {assignment && <button className="btn danger-ghost" disabled={busy} onClick={remove}>確定を外す</button>}
      </div>
    </Sheet>
  );
}
