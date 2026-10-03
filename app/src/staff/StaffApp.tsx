import { useCallback, useEffect, useState } from 'react';
import { friendlyError, staffApi, turnstileSiteKey } from '../lib/api';
import { formatDate, formatRange } from '../lib/time';
import type { Period, StaffMe } from '../lib/types';
import { ErrorBox, Loading, TabBar } from '../ui/components';
import { BoardTab, defaultPeriod, useBoard } from './Board';
import { JoinScreen, PendingScreen, Turnstile } from './Join';
import { SubmitTab } from './SubmitForm';

type Tab = 'submit' | 'board' | 'me';

export function StaffApp({ code }: { code: string }) {
  const [phase, setPhase] = useState<'captcha' | 'loading' | 'ready'>('loading');
  const [storeName, setStoreName] = useState<string | null>(null);
  const [me, setMe] = useState<StaffMe | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('submit');

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const api = staffApi();
      const current = await api.me();
      setMe(current);
      if (current?.status === 'active') {
        setPeriods(await api.periods());
      } else {
        setStoreName(await api.storeByCode(code));
      }
      setPhase('ready');
    } catch (e) {
      setError(friendlyError(e));
      setPhase('ready');
    }
  }, [code]);

  const start = useCallback(async (captcha?: string) => {
    try {
      await staffApi().ensureSession(captcha);
      await load();
    } catch (e) {
      setError(friendlyError(e));
      setPhase('ready');
    }
  }, [load]);

  useEffect(() => {
    // セッションがなく Turnstile が有効なら、先にボット確認を行う
    const hasSession = Object.keys(localStorage).some((k) => k.startsWith('cocos-staff'));
    if (turnstileSiteKey && !hasSession) setPhase('captcha');
    else void start();
  }, [start]);

  if (phase === 'captcha') {
    return (
      <div className="page narrow">
        <h1 className="title">確認しています…</h1>
        <Turnstile onToken={(t) => void start(t)} />
      </div>
    );
  }
  if (phase === 'loading') return <Loading />;
  if (error) return <div className="page narrow"><ErrorBox message={error} /><button className="btn" onClick={() => void load()}>再読み込み</button></div>;

  if (!me) return <JoinScreen code={code} storeName={storeName} onDone={() => void load()} />;
  if (me.status === 'pending') {
    return (
      <PendingScreen
        name={me.display_name}
        storeName={storeName ?? ''}
        onRefresh={() => void load()}
        onRestart={async () => { await staffApi().logout(); await start(); }}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="store">{me.store_name}</span>
        <span className="who">{me.display_name} さん</span>
      </header>
      <main>
        {tab === 'submit' && <SubmitTab periods={periods} />}
        {tab === 'board' && <BoardTab periods={periods} />}
        {tab === 'me' && <MeTab me={me} periods={periods} onLogout={async () => { await staffApi().logout(); await start(); }} />}
      </main>
      <TabBar<Tab>
        value={tab}
        onChange={(t) => { setTab(t); window.scrollTo({ top: 0 }); }}
        tabs={[
          { value: 'submit', label: '提出', icon: '✎' },
          { value: 'board', label: '代わりを探す', icon: '⇄' },
          { value: 'me', label: '自分', icon: '☺' },
        ]}
      />
    </div>
  );
}

function MeTab({ me, periods, onLogout }: { me: StaffMe; periods: Period[]; onLogout: () => void }) {
  const period = defaultPeriod(periods);
  const { rows } = useBoard(period?.id ?? '');
  const mine = (rows ?? []).filter((r) => r.is_me && r.assign_start != null).sort((a, b) => a.work_date.localeCompare(b.work_date));
  return (
    <div className="page">
      <h1 className="title">自分</h1>
      <section className="card">
        <h2 className="section-title">確定シフト{period && `（${period.label}）`}</h2>
        {!period && <p className="empty-line">期間がありません</p>}
        {period && !rows && <Loading />}
        {rows && mine.length === 0 && <p className="empty-line">まだ確定していません</p>}
        <ul className="people">
          {mine.map((r) => (
            <li key={r.work_date}><span className="person">{formatDate(r.work_date)}</span><span className="range assigned">{formatRange(r.assign_start!, r.assign_end!)}</span></li>
          ))}
        </ul>
      </section>
      <section className="card">
        <p><b>{me.display_name}</b> さん（{me.store_name}）</p>
        <p className="muted small">ホーム画面に追加すると、次からアプリのように開けます（共有ボタン →「ホーム画面に追加」）。</p>
        <button className="btn ghost" onClick={() => { if (window.confirm('この端末からログアウトしますか？\n次回は表示名とPINでログインします。')) onLogout(); }}>この端末からログアウト</button>
      </section>
    </div>
  );
}
