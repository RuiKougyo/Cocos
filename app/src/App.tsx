import { useEffect } from 'react';
import { AdminApp } from './admin/AdminApp';
import { isDemo } from './lib/api';
import { DEMO_CODE } from './lib/demoApi';
import { navigate, savedJoinCode, saveJoinCode, useHashPath } from './lib/router';
import { StaffApp } from './staff/StaffApp';

export function App() {
  const path = useHashPath();
  const joinCode = /^\/j\/([A-Za-z0-9]+)$/.exec(path)?.[1] ?? null;

  useEffect(() => {
    // 店舗共通URLで開かれたらコードを端末に保存し、URL からは消す（ホーム画面追加後も使えるように）
    if (joinCode) {
      saveJoinCode(joinCode);
      navigate('/');
    }
  }, [joinCode]);

  useEffect(() => {
    document.title = path.startsWith('/admin') ? 'シフト管理（店長）' : 'シフト提出';
  }, [path]);

  if (joinCode) return null;
  if (path.startsWith('/admin')) return <>{isDemo && <DemoBanner />}<AdminApp /></>;

  const code = savedJoinCode() ?? (isDemo ? DEMO_CODE : null);
  if (!code) {
    return (
      <div className="page narrow">
        <h1 className="title">シフト提出</h1>
        <p className="muted">店長からグループチャットに送られたURLを開いてください。</p>
        <p className="fine"><a href="#/admin">店長の方はこちら</a></p>
      </div>
    );
  }
  return <>{isDemo && <DemoBanner />}<StaffApp code={code} /></>;
}

function DemoBanner() {
  return (
    <div className="demo-banner">
      デモモード（データはこの端末のブラウザ内だけ）
      <a href="#/">スタッフ画面</a>
      <a href="#/admin">店長画面</a>
    </div>
  );
}
