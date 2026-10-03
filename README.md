# Cocos — シフト収集＆空き状況可視化システム

スマートフォンだけで完結する、アルバイトのシフト希望の収集・可視化・代わり探しのシステムです。

- 店長は **毎月1回、グループチャットにURLを1つ貼るだけ**（URLは固定）
- スタッフはそのURLから提出。休みたい日は同じURLの「代わりを探す」で、希望を出していてシフトに入っていない人を確認できる
- 1日は **6:00〜翌2:00**
- 個人情報は表示名のみ。権限は DB（Supabase RLS）で強制

| ドキュメント | 内容 |
| --- | --- |
| [docs/design.md](docs/design.md) | 設計書（技術スタック／データモデル／セキュリティ／画面遷移） |
| [supabase/migrations/](supabase/migrations/) | テーブル・RLS・RPC |
| [supabase/tests/](supabase/tests/) ・ `scripts/test-db.sh` | 権限シナリオテスト |
| [app/](app/) | 画面（React + Vite PWA、デモモード付き） |
