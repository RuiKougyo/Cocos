-- 権限・業務ルールのシナリオテスト。失敗すると例外で停止する。
\set ON_ERROR_STOP 1
\set QUIET 1
create function pg_temp.as_user(p_sub text, p_aal text default 'aal1', p_anon boolean default true)
returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'aal', p_aal, 'is_anonymous', p_anon)::text, false)
$$;
create function pg_temp.expect(p_label text, p_actual anyelement, p_expected anyelement)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: got %, expected %', p_label, p_actual, p_expected;
  end if;
  raise notice 'ok  %', p_label;
end $$;
create temp table ctx (k text primary key, v text);
grant all on ctx to authenticated;

insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000b2'), ('00000000-0000-0000-0000-0000000000b3'),
  ('00000000-0000-0000-0000-0000000000c1');

set role authenticated;

-- 店長: 店舗作成（MFA 必須）
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', false);
select public.create_store('テスト店', '店長');
insert into ctx select 'code', code from public.store_join_codes;
with p as (
  insert into public.shift_periods (store_id, label, start_date, end_date, status)
  select id, '10月前半', '2026-10-01', '2026-10-15', 'open' from public.stores returning id)
insert into ctx select 'period', id::text from p;

-- スタッフA・B がグループ用URLから登録
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect('A register', public.register_member((select v from ctx where k='code'), '山田', '1234'), 'pending');
select pg_temp.expect('pending cannot see period', (select count(*) from public.shift_periods), 0::bigint);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select pg_temp.expect('B register', public.register_member((select v from ctx where k='code'), '佐藤', '5678'), 'pending');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b3');
select pg_temp.expect('duplicate name', public.register_member((select v from ctx where k='code'), ' 山田 ', '0000'), 'name_taken');
select pg_temp.expect('bad code', public.register_member('nope', '鈴木', '0000'), 'invalid_code');

-- 店長が承認
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', false);
select public.approve_member(id) from public.members where role = 'staff';
do $$ begin perform pin_hash from public.members; raise exception 'FAIL pin_hash readable';
exception when insufficient_privilege then raise notice 'ok  pin_hash column hidden'; end $$;

-- A: 提出（17:05〜翌1:30、休みの日に時刻が付いていても捨てられる）
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select public.submit_shift((select v from ctx where k='period')::uuid, '全体備考A',
  '[{"work_date":"2026-10-01","is_available":true,"start_min":1025,"end_min":1530,"note":"非公開メモ"},
    {"work_date":"2026-10-02","is_available":false,"start_min":600,"end_min":720}]');
select public.submit_feedback('見やすくしてほしい');
do $$ begin perform public.submit_shift((select v from ctx where k='period')::uuid, null,
  '[{"work_date":"2026-10-03","is_available":true,"start_min":300,"end_min":600}]');
  raise exception 'FAIL before 6:00 accepted';
exception when check_violation then raise notice 'ok  before 06:00 rejected'; end $$;
do $$ begin perform public.submit_shift((select v from ctx where k='period')::uuid, null,
  '[{"work_date":"2026-10-03","is_available":true,"start_min":600,"end_min":1565}]');
  raise exception 'FAIL after 26:00 accepted';
exception when check_violation then raise notice 'ok  after 翌02:00 rejected'; end $$;
do $$ begin perform public.submit_shift((select v from ctx where k='period')::uuid, null,
  '[{"work_date":"2026-10-03","is_available":true,"start_min":603,"end_min":720}]');
  raise exception 'FAIL non-5-min accepted';
exception when check_violation then raise notice 'ok  non 5-minute rejected'; end $$;

-- B: 提出
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select public.submit_shift((select v from ctx where k='period')::uuid, '全体備考B',
  '[{"work_date":"2026-10-01","is_available":true,"start_min":600,"end_min":900}]');

-- 店長: B を 10/1 に確定
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', false);
insert into public.shift_assignments (period_id, member_id, work_date, start_min, end_min)
select (select v from ctx where k='period')::uuid, id, '2026-10-01', 600, 900 from public.members where display_name = '佐藤';
do $$ begin
  insert into public.shift_assignments (period_id, member_id, work_date, start_min, end_min)
  select (select v from ctx where k='period')::uuid, id, '2026-11-01', 600, 900 from public.members where display_name = '佐藤';
  raise exception 'FAIL out-of-period assignment';
exception when insufficient_privilege then raise notice 'ok  out-of-period assignment rejected'; end $$;
select pg_temp.expect('admin sees all submissions', (select count(*) from public.submissions), 2::bigint);
select pg_temp.expect('admin sees feedback', (select count(*) from public.feedback), 1::bigint);

-- B から見た空き状況ボード: A の時間は見えるが、A の備考・提出テーブルは見えない
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select pg_temp.expect('B: board rows', (select count(*) from public.availability_board((select v from ctx where k='period')::uuid)), 2::bigint);
select pg_temp.expect('B: A available 17:05-25:30',
  (select avail_start::text || '-' || avail_end from public.availability_board((select v from ctx where k='period')::uuid) where display_name = '山田'),
  '1025-1530');
select pg_temp.expect('B: own assignment visible',
  (select assign_start from public.availability_board((select v from ctx where k='period')::uuid) where is_me), 600::smallint);
select pg_temp.expect('B: other submissions hidden', (select count(*) from public.submissions), 1::bigint);
select pg_temp.expect('B: other day notes hidden', (select count(*) from public.submission_days where note is not null), 0::bigint);
select pg_temp.expect('B: members (self only)', (select count(*) from public.members), 1::bigint);
select pg_temp.expect('B: feedback hidden', (select count(*) from public.feedback), 0::bigint);
select pg_temp.expect('B: join code hidden', (select count(*) from public.store_join_codes), 0::bigint);

-- 未紐付けの匿名ユーザー（URLを知っているだけの人）
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.expect('stranger: board empty', (select count(*) from public.availability_board((select v from ctx where k='period')::uuid)), 0::bigint);
select pg_temp.expect('stranger: periods', (select count(*) from public.shift_periods), 0::bigint);

-- 機種変更: A が新端末(c1)から表示名＋PINでログイン。間違い5回でロック
select pg_temp.expect('wrong pin', public.login_member((select v from ctx where k='code'), '山田', '0000'), 'invalid');
select public.login_member((select v from ctx where k='code'), '山田', '0000') from generate_series(1, 4);
select pg_temp.expect('locked after 5', public.login_member((select v from ctx where k='code'), '山田', '1234'), 'locked');
reset role;
update public.members set locked_until = now() - interval '1 second' where display_name = '山田';
set role authenticated;
select pg_temp.expect('login ok', public.login_member((select v from ctx where k='code'), '山田', '1234'), 'ok');
select pg_temp.expect('new device sees own submission', (select count(*) from public.submissions), 1::bigint);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect('old device logged out', (select count(*) from public.submissions), 0::bigint);

-- 店長: MFA なしでは何も見えない
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal1', false);
select pg_temp.expect('admin aal1: submissions', (select count(*) from public.submissions), 0::bigint);

-- 店長: 未提出者・退職処理
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', false);
select pg_temp.expect('unsubmitted none', (select count(*) from public.unsubmitted_members((select v from ctx where k='period')::uuid)), 0::bigint);
select public.retire_member(id) from public.members where display_name = '佐藤';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select pg_temp.expect('retired: no access', (select count(*) from public.shift_periods), 0::bigint);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select pg_temp.expect('retired gone from board', (select count(*) from public.availability_board((select v from ctx where k='period')::uuid) where display_name = '佐藤'), 0::bigint);
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a', 'aal2', false);
select public.delete_member_now(id) from public.members where display_name = '佐藤';
select pg_temp.expect('deleted cascade', (select count(*) from public.submissions), 1::bigint);

-- URL 再発行で旧URLは無効
insert into ctx values ('old', (select v from ctx where k='code'));
select public.rotate_join_code();
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b3');
select pg_temp.expect('old code invalid', public.register_member((select v from ctx where k='old'), '鈴木', '1111'), 'invalid_code');

reset role;
select public.purge_expired_data();
do $$ begin raise notice 'ALL TESTS PASSED'; end $$;
