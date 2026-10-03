import { useEffect, useRef, useState } from 'react';
import { friendlyError, isDemo, staffApi, turnstileSiteKey } from '../lib/api';
import { ErrorBox } from '../ui/components';

/** Turnstile（ボット対策）。サイトキー未設定なら何もしない */
export function Turnstile({ onToken }: { onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!turnstileSiteKey) return;
    type TS = { render: (el: HTMLElement, o: Record<string, unknown>) => void };
    const w = window as unknown as { turnstile?: TS };
    const render = () => w.turnstile?.render(ref.current!, { sitekey: turnstileSiteKey, callback: onToken });
    if (w.turnstile) { render(); return; }
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [onToken]);
  return <div ref={ref} className="turnstile" />;
}

type Mode = 'welcome' | 'register' | 'login';

export function JoinScreen(props: { code: string; storeName: string | null; onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('welcome');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (props.storeName === null) {
    return (
      <div className="page narrow">
        <h1 className="title">URLが無効です</h1>
        <p className="muted">このURLは使えなくなっています。店長からグループに送られた最新のURLを開いてください。</p>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('表示名を入力してください');
    if (!/^\d{4}$/.test(pin)) return setError('PINは数字4桁で入力してください');
    if (mode === 'register' && pin !== pin2) return setError('PINが一致しません');
    setBusy(true);
    try {
      const api = staffApi();
      const r = mode === 'register' ? await api.register(props.code, name, pin) : await api.login(props.code, name, pin);
      const messages: Record<string, string> = {
        name_taken: 'その表示名はすでに使われています。前に登録した方は「前に登録した方」からログインしてください。',
        invalid: '表示名またはPINが違います。',
        locked: 'PINを続けて間違えたため、一時的にロックされています。しばらく待つか、店長にリセットを頼んでください。',
        invalid_code: 'このURLは使えなくなっています。最新のURLを開いてください。',
        too_many_pending: '登録の申請が多すぎます。店長に連絡してください。',
      };
      if (messages[r]) setError(messages[r]);
      else props.onDone();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'welcome') {
    return (
      <div className="page narrow">
        <p className="eyebrow">シフト提出</p>
        <h1 className="title">{props.storeName}</h1>
        <p className="muted">この端末で使うのは初めてです。どちらかを選んでください。</p>
        <div className="stack">
          <button className="btn primary big" onClick={() => setMode('register')}>はじめて使う</button>
          <button className="btn big" onClick={() => setMode('login')}>前に登録した方（機種変更など）</button>
        </div>
        <p className="fine">保存するのは表示名だけです。電話番号やメールアドレスは使いません。</p>
        {isDemo && <p className="demo-note">デモ: 「前に登録した方」から <b>山田</b> / PIN <b>1234</b> でログインできます。</p>}
      </div>
    );
  }

  return (
    <form className="page narrow" onSubmit={submit}>
      <button type="button" className="link-btn" onClick={() => { setMode('welcome'); setError(null); }}>‹ 戻る</button>
      <h1 className="title">{mode === 'register' ? 'はじめての登録' : 'ログイン'}</h1>
      <div className="card">
        <label className="field">
          <span>表示名</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="nickname" placeholder="例: 山田 T" />
          {mode === 'register' && <small>店長と仲間が見て分かる名前（フルネームでなくてOK）</small>}
        </label>
        <label className="field">
          <span>PIN（数字4桁）</span>
          <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
          {mode === 'register' && <small>機種変更したときに使います。忘れたら店長がリセットできます。</small>}
        </label>
        {mode === 'register' && (
          <label className="field">
            <span>PIN（確認）</span>
            <input value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" type="password" autoComplete="new-password" />
          </label>
        )}
      </div>
      <ErrorBox message={error} />
      <button className="btn primary big" disabled={busy}>{busy ? '送信中…' : mode === 'register' ? '登録を申請する' : 'ログイン'}</button>
    </form>
  );
}

export function PendingScreen(props: { name: string; storeName: string; onRefresh: () => void; onRestart: () => void }) {
  return (
    <div className="page narrow">
      <p className="eyebrow">{props.storeName}</p>
      <h1 className="title">店長の承認待ちです</h1>
      <div className="card">
        <p><b>{props.name}</b> さんとして登録を申請しました。</p>
        <p className="muted">店長が承認すると、シフトの提出と「代わりを探す」が使えるようになります。グループチャットで店長に一言伝えてください。</p>
      </div>
      <div className="stack">
        <button className="btn primary big" onClick={props.onRefresh}>承認されたか確認する</button>
        <button className="btn ghost" onClick={props.onRestart}>名前を間違えた（登録をやり直す）</button>
      </div>
      {isDemo && <p className="demo-note">デモ: 店長画面（#/admin）の「メンバー」から承認できます。</p>}
    </div>
  );
}
