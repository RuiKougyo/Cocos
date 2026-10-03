-- ローカル PostgreSQL で RLS をテストするための Supabase 最小スタブ（本番では使わない）
create role anon nologin;
create role authenticated nologin;
create schema extensions;
create schema auth;
grant usage on schema auth, extensions, public to anon, authenticated;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant execute on all functions in schema auth to anon, authenticated;
-- Supabase と同様、新規テーブルには既定で広い権限が付く（マイグレーション側で取り消せているかを検証する）
alter default privileges in schema public grant all on tables to anon, authenticated;
