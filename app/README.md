# 画面（React + Vite PWA）

## 動かす

```bash
cd app
npm install
npm run dev        # http://localhost:5173
```

接続先は `.env` で選びます（`.env.example` 参照）。何も設定しなければ **デモモード** で動きます（データはブラウザ内だけ）。

| `VITE_BACKEND` | 接続先 |
| --- | --- |
| `gas` | 無料版: Google Apps Script（`VITE_GAS_URL`）。導入は [docs/setup-free.md](../docs/setup-free.md) |
| `supabase` | 有料版: Supabase（`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`） |
| （なし） | デモ |

| URL | 画面 |
| --- | --- |
| `/#/j/demo` | グループに貼るURL（スタッフの入口）。デモでは「前に登録した方」→ 山田 / 1234 でログイン可 |
| `/#/admin` | 店長画面。デモでは任意のメール・パスワード → 任意の6桁で入れます |

## 有料版（Supabase）に接続する

1. Supabase で東京リージョンのプロジェクトを作成し、`supabase/migrations/` を適用する
2. Auth 設定: Email サインアップを無効化（店長アカウントは管理画面から発行）、**Anonymous sign-ins を有効化**、MFA（TOTP）を有効化、CAPTCHA（Turnstile）を有効化
3. `.env.example` を `.env` にコピーして URL・anon キー・Turnstile のサイトキーを設定
4. `npm run build` → `dist/` を Cloudflare Pages に配置（`public/_headers` でセキュリティヘッダが付きます）
5. 店長がログイン → 店舗の初期設定 → 「メンバー・設定」の募集文をグループに貼る

## 構成

```
src/
  lib/time.ts          営業日（6:00〜翌2:00）と分の変換・5分丸め
  lib/types.ts         API の型
  lib/gasApi.ts        無料版の実装（Apps Script を呼ぶ。混雑時は自動で再送）
  lib/supabaseApi.ts   有料版の実装（RLS / RPC を呼ぶ）
  lib/demoApi.ts       デモ実装（DB と同じルールをブラウザ内で再現）
  staff/               J0〜J3 登録・承認待ち、S1 提出、S3 代わりを探す、S4 自分
  admin/               A0 ログイン(MFA)、A1 タイムライン、A2 未提出、A3 改善要望、A4 メンバー・設定
```

## チェック

```bash
npm run typecheck && npm test && npm run build
../scripts/test-db.sh   # DB の権限テスト（ローカル PostgreSQL 16+ が必要）
```
