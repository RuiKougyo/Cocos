import { useEffect, useState, type ReactNode } from 'react';
import { formatMin, parsePickerValue, toInputValue } from '../lib/time';

export function Segmented<T extends string>(props: {
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          className={props.value === o.value ? `on on-${o.value}` : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 端末標準のドラムロールで時刻を入力する。
 * 06:00 より前は翌日扱い。5 分刻みでない値は丸めて、その旨を表示する。
 */
export function TimeField(props: {
  label: string;
  value: number | null;
  onChange: (min: number | null) => void;
}) {
  const [text, setText] = useState(toInputValue(props.value));
  const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  useEffect(() => setText(toInputValue(props.value)), [props.value]);

  function apply(raw: string, final: boolean) {
    if (!raw) { props.onChange(null); setMsg(null); return; }
    const r = parsePickerValue(raw);
    if (!r.ok) { setMsg({ kind: 'error', text: r.error }); props.onChange(null); return; }
    props.onChange(r.min);
    if (final) {
      setText(toInputValue(r.min));
      setMsg(r.rounded ? { kind: 'info', text: `5分刻みに調整しました（${raw} → ${formatMin(r.min)}）` } : null);
    }
  }

  return (
    <label className="timefield">
      <span className="timefield-label">{props.label}</span>
      <input
        type="time"
        step={300}
        value={text}
        onChange={(e) => { setText(e.target.value); apply(e.target.value, false); }}
        onBlur={(e) => apply(e.target.value, true)}
      />
      {props.value != null && props.value >= 1440 && <span className="badge-next">翌{formatMin(props.value).slice(1)}</span>}
      {msg && <span className={`field-msg ${msg.kind}`}>{msg.text}</span>}
    </label>
  );
}

export function Sheet(props: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [props]);
  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{props.title}</h2>
          <button className="icon-btn" aria-label="閉じる" onClick={props.onClose}>×</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function TabBar<T extends string>(props: {
  value: T;
  tabs: { value: T; label: string; icon: string; badge?: number }[];
  onChange: (v: T) => void;
}) {
  return (
    <nav className="tabbar">
      {props.tabs.map((t) => (
        <button key={t.value} className={props.value === t.value ? 'on' : ''} onClick={() => props.onChange(t.value)}>
          <span className="tab-icon" aria-hidden>{t.icon}</span>
          <span>{t.label}</span>
          {!!t.badge && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </nav>
  );
}

export function Loading() {
  return <div className="loading" aria-live="polite">読み込み中…</div>;
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-box" role="alert">{message}</div>;
}

let toastTimer: number | undefined;
export function toast(text: string) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = 'show';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el!.className = ''; }, 2400);
}

export async function copyText(text: string, done = 'コピーしました') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    window.prompt('コピーしてください', text);
  }
}
