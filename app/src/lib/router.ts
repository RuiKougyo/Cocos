import { useEffect, useState } from 'react';

// ハッシュルーティング（URL の # 以降はサーバーに送られず、アクセスログに残らない）
//   #/j/<code>  店舗共通URL（グループチャットに貼るもの）
//   #/admin     店長画面
//   #/          ホーム（保存済みの店舗コードがあればスタッフ画面）
export function useHashPath(): string {
  const [path, setPath] = useState(() => location.hash.replace(/^#/, '') || '/');
  useEffect(() => {
    const on = () => setPath(location.hash.replace(/^#/, '') || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return path;
}

export function navigate(path: string) {
  location.hash = path;
}

const CODE_KEY = 'cocos-join-code';
export function savedJoinCode(): string | null {
  try { return localStorage.getItem(CODE_KEY); } catch { return null; }
}
export function saveJoinCode(code: string) {
  try { localStorage.setItem(CODE_KEY, code); } catch { /* 保存できなくても続行 */ }
}

export function joinUrl(code: string): string {
  return `${location.origin}${location.pathname}#/j/${code}`;
}
