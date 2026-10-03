import { useCallback, useEffect, useState } from 'react';
import { adminApi, friendlyError, isDemo } from '../lib/api';
import { resetDemo } from '../lib/demoApi';
import { joinUrl } from '../lib/router';
import { addDays, businessToday, formatDate, formatDateTime } from '../lib/time';
import type { Feedback, Member, Period, PeriodStatus } from '../lib/types';
import { copyText, ErrorBox, Loading, Sheet, toast } from '../ui/components';

export function periodRange(p: Period) {
  return `${formatDate(p.start_date)}〜${formatDate(p.end_date)}`;
}

export function UnsubmittedTab({ period }: { period: Period }) {
  const [list, setList] = useState<{ member_id: string; display_name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setList(null);
    adminApi().unsubmitted(period.id).then(setList).catch((e) => setError(friendlyError(e)));
  }, [period.id]);
  return (
    <div className="page">
      <h1 className="title">未提出 <span className="count">{list?.length ?? ''}</span></h1>
      <p className="muted small">{period.label}（{periodRange(period)}）</p>
      <ErrorBox message={error} />
      {!list ? <Loading /> : list.length === 0 ? (
        <div className="card empty">全員提出済みです 🎉</div>
      ) : (
        <>
          <ul className="card people">
            {list.map((m) => <li key={m.member_id}><span className="person">{m.display_name}</span></li>)}
          </ul>
          <button className="btn big" onClick={() => copyText(`【シフト未提出】${period.label}\n${list.map((m) => m.display_name).join('、')} さん\n提出をお願いします！`, '催促文をコピーしました')}>
            催促文をコピー（グループに貼る用）
          </button>
        </>
      )}
    </div>
  );
}

export function FeedbackTab() {
  const [list, setList] = useState<Feedback[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { adminApi().feedback().then(setList).catch((e) => setError(friendlyError(e))); }, []);
  return (
    <div className="page">
      <h1 className="title">改善要望</h1>
      <p className="muted small">スタッフからの匿名の意見です（投稿者は記録していません）。</p>
      <ErrorBox message={error} />
      {!list ? <Loading /> : list.length === 0 ? <div className="card empty">まだありません</div> : list.map((f) => (
        <article key={f.id} className="card feedback-item">
          <time>{formatDateTime(f.created_at)}</time>
          <p>{f.body}</p>
        </article>
      ))}
    </div>
  );
}

const STATUS_LABEL: Record<PeriodStatus, string> = { draft: '下書き', open: '受付中', closed: '締切' };

export function MembersTab(props: { periods: Period[]; onChanged: () => Promise<void>; onSignOut: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Member | null>(null);
  const [newPeriod, setNewPeriod] = useState(false);

  const load = useCallback(async () => {
    try {
      const api = adminApi();
      const [m, c] = await Promise.all([api.members(), api.joinCode()]);
      setMembers(m);
      setCode(c);
    } catch (e) { setError(friendlyError(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      setTarget(null);
      await load();
      await props.onChanged();
    } catch (e) { setError(friendlyError(e)); }
  };

  if (!members || !code) return error ? <ErrorBox message={error} /> : <Loading />;

  const url = joinUrl(code);
  const openPeriod = props.periods.find((p) => p.status === 'open');
  const message = openPeriod
    ? `【シフト提出】${openPeriod.label}（${periodRange(openPeriod)}）の希望を提出してください。\n${openPeriod.deadline ? `締切: ${formatDateTime(openPeriod.deadline)}\n` : ''}休みたい日の代わり探しも同じURLからできます。\n${url}`
    : `シフト提出・代わり探しはこちら\n${url}`;
  const pending = members.filter((m) => m.status === 'pending');
  const active = members.filter((m) => m.status === 'active');
  const retired = members.filter((m) => m.status === 'retired');

  return (
    <div className="page">
      <h1 className="title">メンバー・設定</h1>
      <ErrorBox message={error} />

      <section className="card">
        <h2 className="section-title">グループ用URL</h2>
        <p className="muted small">毎月、下の文をグループチャットに貼るだけでOKです。URLはずっと同じです。</p>
        <pre className="message-preview">{message}</pre>
        <div className="row">
          <button className="btn primary" onClick={() => copyText(message, '募集文をコピーしました')}>募集文をコピー</button>
          {'share' in navigator && <button className="btn" onClick={() => navigator.share({ text: message }).catch(() => {})}>共有…</button>}
        </div>
        <details className="danger-zone">
          <summary>URLが店外に漏れたとき</summary>
          <p className="muted small">再発行すると古いURLは使えなくなります。登録済みのスタッフの端末はそのまま使えます。</p>
          <button className="btn danger-ghost" onClick={() => { if (window.confirm('URLを再発行しますか？古いURLは使えなくなります。')) void run(async () => setCode(await adminApi().rotateJoinCode()), 'URLを再発行しました'); }}>URLを再発行</button>
        </details>
      </section>

      {pending.length > 0 && (
        <section className="card highlight">
          <h2 className="section-title">参加申請 <span className="count">{pending.length}</span></h2>
          <ul className="people">
            {pending.map((m) => (
              <li key={m.id}>
                <span className="person">{m.display_name}<small>{m.approved_at ? 'PINの再設定' : '新規'}・{formatDateTime(m.created_at)}</small></span>
                <span className="actions">
                  <button className="btn small primary" onClick={() => void run(() => adminApi().approve(m.id), `${m.display_name}さんを承認しました`)}>承認</button>
                  {!m.approved_at && <button className="btn small ghost" onClick={() => { if (window.confirm(`${m.display_name}さんの申請を却下しますか？`)) void run(() => adminApi().reject(m.id), '却下しました'); }}>却下</button>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2 className="section-title">募集期間</h2>
        <ul className="people">
          {props.periods.map((p) => (
            <li key={p.id}>
              <span className="person">{p.label}<small>{periodRange(p)}</small></span>
              <select className={`status-select ${p.status}`} value={p.status} aria-label={`${p.label} の状態`} onChange={(e) => void run(() => adminApi().setPeriodStatus(p.id, e.target.value as PeriodStatus), '状態を変更しました')}>
                {(Object.keys(STATUS_LABEL) as PeriodStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </li>
          ))}
        </ul>
        <button className="btn" onClick={() => setNewPeriod(true)}>＋ 期間を作成</button>
        <p className="fine">下書き: スタッフに見えない／受付中: 提出できる／締切: 閲覧のみ</p>
      </section>

      <section className="card">
        <h2 className="section-title">スタッフ <span className="count">{active.length}</span></h2>
        <ul className="people">
          {active.map((m) => (
            <li key={m.id}>
              <span className="person">{m.display_name}{m.locked_until && new Date(m.locked_until) > new Date() && <small className="warn">PINロック中</small>}</span>
              <button className="btn small ghost" onClick={() => setTarget(m)}>管理</button>
            </li>
          ))}
        </ul>
      </section>

      {retired.length > 0 && (
        <section className="card">
          <h2 className="section-title">退職処理済み</h2>
          <p className="muted small">退職処理から30日後に自動で完全削除されます。</p>
          <ul className="people">
            {retired.map((m) => (
              <li key={m.id}>
                <span className="person">{m.display_name}<small>{formatDateTime(m.retired_at!)} 処理</small></span>
                <span className="actions">
                  <button className="btn small ghost" onClick={() => void run(() => adminApi().restore(m.id), '元に戻しました')}>元に戻す</button>
                  <button className="btn small danger-ghost" onClick={() => { if (window.confirm(`${m.display_name}さんのデータを完全に削除します。元に戻せません。`)) void run(() => adminApi().deleteNow(m.id), '完全に削除しました'); }}>今すぐ削除</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <button className="btn ghost" onClick={props.onSignOut}>ログアウト</button>
        {isDemo && <button className="btn ghost" onClick={() => { resetDemo(); location.reload(); }}>デモデータを初期化</button>}
      </section>

      {target && <MemberSheet member={target} onClose={() => setTarget(null)} run={run} />}
      {newPeriod && <PeriodSheet onClose={() => setNewPeriod(false)} run={run} periods={props.periods} />}
    </div>
  );
}

function MemberSheet({ member, onClose, run }: { member: Member; onClose: () => void; run: (fn: () => Promise<unknown>, done: string) => Promise<void> }) {
  const [name, setName] = useState(member.display_name);
  return (
    <Sheet title={member.display_name} onClose={onClose}>
      <label className="field">
        <span>表示名</span>
        <div className="row">
          <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
          <button className="btn" disabled={!name.trim() || name === member.display_name} onClick={() => void run(() => adminApi().rename(member.id, name), '変更しました')}>変更</button>
        </div>
      </label>
      <div className="stack">
        <button className="btn" onClick={() => { if (window.confirm(`${member.display_name}さんのログインをリセットしますか？\n本人が新しいPINでログインした後、もう一度承認が必要です。`)) void run(() => adminApi().resetLogin(member.id), 'リセットしました'); }}>
          ログインをリセット（PIN忘れ・ロック解除）
        </button>
        <button className="btn danger-ghost" onClick={() => {
          const typed = window.prompt(`退職処理をすると、すぐにログインできなくなり、今日以降の確定シフトも外れます。\n確認のため「${member.display_name}」と入力してください。`);
          if (typed?.trim() === member.display_name) void run(() => adminApi().retire(member.id), '退職処理をしました');
          else if (typed != null) toast('名前が一致しませんでした');
        }}>
          退職処理
        </button>
      </div>
    </Sheet>
  );
}

function PeriodSheet({ onClose, run, periods }: { onClose: () => void; run: (fn: () => Promise<unknown>, done: string) => Promise<void>; periods: Period[] }) {
  // 直近の期間の翌日から 15 日間を初期値にする
  const last = [...periods].sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
  const initStart = last ? addDays(last.end_date, 1) : businessToday();
  const [label, setLabel] = useState('');
  const [start, setStart] = useState(initStart);
  const [end, setEnd] = useState(addDays(initStart, 14));
  const [deadline, setDeadline] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title="期間を作成" onClose={onClose}>
      <label className="field"><span>名前</span><input value={label} maxLength={30} placeholder="例: 11月前半" onChange={(e) => setLabel(e.target.value)} /></label>
      <div className="row">
        <label className="field"><span>開始日</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="field"><span>終了日</span><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      </div>
      <label className="field"><span>提出締切（任意）</span><input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></label>
      <p className="fine">{start && end && `${formatDate(start)}〜${formatDate(end)}`}。作成後は「下書き」です。準備ができたら「受付中」にしてください。</p>
      <ErrorBox message={error} />
      <button className="btn primary big" onClick={() => {
        if (!label.trim()) return setError('名前を入力してください');
        if (!start || !end || end < start) return setError('日付を確認してください');
        if (addDays(start, 31) < end) return setError('期間は32日以内にしてください');
        void run(() => adminApi().createPeriod({
          label: label.trim(), start_date: start, end_date: end,
          deadline: deadline ? new Date(deadline).toISOString() : null,
          view_start_min: 360, view_end_min: 1560,
        }), '期間を作成しました').then(onClose);
      }}>作成</button>
    </Sheet>
  );
}
