# Cocos — シフト収集＆空き状況可視化システム

スマートフォンだけで完結する、アルバイトのシフト希望収集と空き状況可視化のシステムです。

- 設計書: [docs/design.md](docs/design.md)（技術スタック／データモデル／セキュリティ方針／画面遷移）
- DB スキーマ・RLS・RPC: [supabase/migrations/20261003000000_init.sql](supabase/migrations/20261003000000_init.sql)

構成: Supabase（東京リージョン、PostgreSQL RLS、Auth）＋ React/Vite PWA（Cloudflare Pages）
