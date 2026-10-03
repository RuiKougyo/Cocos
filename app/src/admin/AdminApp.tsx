import { useCallback, useEffect, useState } from 'react';
import { adminApi, friendlyError, isDemo } from '../lib/api';
import { businessToday } from '../lib/time';
import type { AdminMe, AdminSignIn, Period } from '../lib/types';
import { copyText, ErrorBox, Loading, TabBar } from '../ui/components';
import { FeedbackTab, MembersTab, UnsubmittedTab } from './Tabs';
import { TimelineTab } from './Timeline';

type Tab = 'timeline' | 'unsubmitted' | 'feedback' | 'members';

export function AdminApp() {
  const [auth, setAuth] = useState<'loading' | 'setup' | 'not_initialized' | 'none' | 'mfa' | 'ok'>('loading');
  const [enroll, setEnroll] = useState<Extract<AdminSignIn, { next: 'enroll' }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const api = adminApi();
      // 無料版: 店長がまだ登録されていなければ初期設定画面へ
      const state = api.setupState ? await api.setupState() : 'ready';
      if (state === 'needs_setup') return setAuth('setup');
      if (state === 'not_initialized') return setAuth('not_initialized');
      setAuth(await api.session());
    })().catch((e) => { setError(friendlyError(e)); setAuth('none'); });
  }, []);

  const next = (r: AdminSignIn) => { setEnroll(r.next === 'enroll' ? r : null); setAuth(r.next === 'done' ? 'ok' : 'mfa'); };

  if (auth === 'loading') return <Loading />;
  if (auth === 'not_initialized') {
    return (
      <div className="page narrow">
        <h1 className="title">準備がまだです</h1>
        <p className="muted">スプレッドシートの Apps Script で <code>initialize</code> を実行してください（手順書 docs/setup-free.md）。</p>
      </div>
    );
  }
  if (auth === 'setup') return <SetupForm onNext={next} />;
  if (auth === 'none') return <><ErrorBox message={error} /><LoginForm onNext={next} /></>;
  if (auth === 'mfa') return <MfaForm enroll={enroll} onDone={() => setAuth('ok')} onBack={async () => { await adminApi().signOut(); setAuth('none'); }} />;
  return <AdminHome onSignOut={async () => { await adminApi().signOut(); setAuth('none'); }} />;
}

function SetupForm({ onNext }: { onNext: (r: AdminSignIn) => void }) {
  const [code, setCode] = useState('');
  const [store, setStore] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="page narrow" onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      if (pw.length < 10) return setError('パスワードは10文字以上にしてください。');
      if (pw !== pw2) return setError('パスワードが一致しません。');
      setBusy(true);
      try { onNext(await adminApi().setupAdmin!(code.trim(), store.trim(), pw)); } catch (err) { setError(friendlyError(err)); } finally { setBusy(false); }
    }}>
      <p className="eyebrow">店長用</p>
      <h1 className="title">初期設定</h1>
      <p className="muted small">最初の1回だけです。初期設定コードは Apps Script で initialize を実行したときに表示されます。</p>
      <div className="card">
        <label className="field"><span>初期設定コード</span><input value={code} autoCapitalize="characters" autoComplete="off" onChange={(e) => setCode(e.target.value)} required /></label>
        <label className="field"><span>店舗名</span><input value={store} maxLength={50} onChange={(e) => setStore(e.target.value)} required /></label>
        <label className="field"><span>店長用パスワード（10文字以上）</span><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
        <label className="field"><span>パスワード（確認）</span><input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></label>
      </div>
      <ErrorBox message={error} />
      <button className="btn primary big" disabled={busy}>{busy ? '処理中…' : '次へ（認証アプリの登録）'}</button>
    </form>
  );
}

function LoginForm({ onNext }: { onNext: (r: AdminSignIn) => void }) {
  const withEmail = adminApi().loginKind === 'email';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="page narrow" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      try { onNext(await adminApi().signIn(email, password)); } catch (err) { setError(friendlyError(err)); } finally { setBusy(false); }
    }}>
      <p className="eyebrow">店長用</p>
      <h1 className="title">ログイン</h1>
      <div className="card">
        {withEmail && <label className="field"><span>メールアドレス</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>}
        <label className="field"><span>パスワード</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      </div>
      <ErrorBox message={error} />
      <button className="btn primary big" disabled={busy}>{busy ? '確認中…' : '次へ'}</button>
      {isDemo && <p className="demo-note">デモ: 何を入力しても次へ進めます。</p>}
    </form>
  );
}

function MfaForm(props: { enroll: Extract<AdminSignIn, { next: 'enroll' }> | null; onDone: () => void; onBack: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="page narrow" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      try { await adminApi().verifyMfa(code); props.onDone(); } catch (err) { setError(friendlyError(err)); } finally { setBusy(false); }
    }}>
      <button type="button" className="link-btn" onClick={props.onBack}>‹ 戻る</button>
      <h1 className="title">{props.enroll ? '認証アプリの登録' : '認証コード'}</h1>
      {props.enroll && (
        <div className="card center">
          <p className="muted small">Google Authenticator などの認証アプリ（無料）に登録します。ログインのたびに、アプリに表示される6桁のコードを入力します。</p>
          {props.enroll.qr && <img className="qr" src={props.enroll.qr} alt="認証アプリ登録用QRコード" />}
          {props.enroll.otpauth && <a className="btn primary" href={props.enroll.otpauth}>認証アプリに登録する</a>}
          <p className="fine">うまく開かない場合は、認証アプリの「セットアップキーを入力」に次のキーを貼り付けてください。</p>
          <p><code>{props.enroll.secret}</code></p>
          <button type="button" className="btn small" onClick={() => copyText(props.enroll!.secret, 'キーをコピーしました')}>キーをコピー</button>
        </div>
      )}
      <div className="card">
        <label className="field">
          <span>認証アプリに表示された6桁のコード</span>
          <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>
      </div>
      <ErrorBox message={error} />
      <button className="btn primary big" disabled={busy || code.length !== 6}>確認</button>
      {isDemo && <p className="demo-note">デモ: 任意の6桁（例 123456）で進めます。</p>}
    </form>
  );
}

function StoreSetup({ onDone }: { onDone: () => void }) {
  const [store, setStore] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="page narrow" onSubmit={async (e) => {
      e.preventDefault();
      try { await adminApi().createStore(store, name); onDone(); } catch (err) { setError(friendlyError(err)); }
    }}>
      <h1 className="title">店舗の初期設定</h1>
      <div className="card">
        <label className="field"><span>店舗名</span><input value={store} maxLength={50} onChange={(e) => setStore(e.target.value)} required /></label>
        <label className="field"><span>あなたの表示名</span><input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} required placeholder="例: 店長" /></label>
      </div>
      <ErrorBox message={error} />
      <button className="btn primary big">作成</button>
    </form>
  );
}

function AdminHome({ onSignOut }: { onSignOut: () => void }) {
  const [me, setMe] = useState<AdminMe | null | undefined>(undefined);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState('');
  const [pending, setPending] = useState(0);
  const [tab, setTab] = useState<Tab>('timeline');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const api = adminApi();
      const m = await api.me();
      setMe(m);
      if (!m) return;
      const [ps, members] = await Promise.all([api.periods(), api.members()]);
      setPeriods(ps);
      setPending(members.filter((x) => x.status === 'pending').length);
      setPeriodId((cur) => {
        if (ps.some((p) => p.id === cur)) return cur;
        const today = businessToday();
        return (ps.find((p) => p.start_date <= today && today <= p.end_date) ?? ps.find((p) => p.status === 'open') ?? ps[0])?.id ?? '';
      });
    } catch (e) { setError(friendlyError(e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  if (error) return <div className="page narrow"><ErrorBox message={error} /></div>;
  if (me === undefined) return <Loading />;
  if (me === null) return <StoreSetup onDone={() => void refresh()} />;

  const period = periods.find((p) => p.id === periodId);
  const needsPeriod = tab === 'timeline' || tab === 'unsubmitted';

  return (
    <div className={`app-shell admin ${tab === 'timeline' ? 'full' : ''}`}>
      <header className="topbar">
        <span className="store">{me.store_name}</span>
        {needsPeriod && periods.length > 0 ? (
          <select className="period-select" value={periodId} onChange={(e) => setPeriodId(e.target.value)} aria-label="期間">
            {periods.map((p) => (
              <option key={p.id} value={p.id}>{p.label}{p.status === 'draft' ? '（下書き）' : p.status === 'open' ? '（受付中）' : ''}</option>
            ))}
          </select>
        ) : <span className="who">店長</span>}
      </header>
      <main>
        {needsPeriod && !period && (
          <div className="page"><div className="card empty">募集期間がありません。「メンバー・設定」から作成してください。</div></div>
        )}
        {tab === 'timeline' && period && <TimelineTab key={period.id} period={period} storeName={me.store_name} />}
        {tab === 'unsubmitted' && period && <UnsubmittedTab period={period} />}
        {tab === 'feedback' && <FeedbackTab />}
        {tab === 'members' && <MembersTab periods={periods} onChanged={refresh} onSignOut={onSignOut} />}
      </main>
      <TabBar<Tab>
        value={tab}
        onChange={(t) => { setTab(t); window.scrollTo({ top: 0 }); }}
        tabs={[
          { value: 'timeline', label: 'タイムライン', icon: '▥' },
          { value: 'unsubmitted', label: '未提出', icon: '!' },
          { value: 'feedback', label: '改善要望', icon: '💡' },
          { value: 'members', label: 'メンバー・設定', icon: '⚙', badge: pending },
        ]}
      />
    </div>
  );
}
