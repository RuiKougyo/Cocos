# Cocos — シフト収集＆空き状況可視化システム

スマートフォンだけで完結する、アルバイトのシフト希望の収集・可視化・代わり探しのシステムです。**完全無料で運用できます。**

- 店長は **毎月1回、グループチャットにURLを1つ貼るだけ**（URLは固定）
- スタッフはそのURLから提出。休みたい日は同じURLの「代わりを探す」で、希望を出していてシフトに入っていない人を確認できる
- 1日は **6:00〜翌2:00**
- 個人情報は表示名のみ

| 構成 | 費用 | 内容 |
| --- | --- | --- |
| **無料版（標準）** | 0円 | Google スプレッドシート + Apps Script（[`gas/`](gas/)）+ Cloudflare Pages。導入手順: [docs/setup-free.md](docs/setup-free.md) |
| 有料版 | 約$25/月 | Supabase（[`supabase/`](supabase/)）+ Cloudflare Pages |

| ドキュメント | 内容 |
| --- | --- |
| [docs/setup-free.md](docs/setup-free.md) | 無料版の導入手順（店長・導入担当者向け） |
| [docs/design.md](docs/design.md) | 設計書（技術スタック／データモデル／セキュリティ／画面遷移） |
| [app/](app/) | 画面（React + Vite PWA、デモモード付き） |

## 開発

```bash
cd app && npm install && npm run dev       # デモモードで起動
node --test gas/test/*.test.mjs                      # 無料版バックエンドのテスト
./scripts/test-db.sh                       # 有料版 DB の権限テスト
```

無料版をローカルで試す場合は `node gas/dev/server.mjs` を起動し、`app/.env.local` に
`VITE_BACKEND=gas` と `VITE_GAS_URL=http://localhost:8787/exec` を設定してから `npm run dev` を実行します。
