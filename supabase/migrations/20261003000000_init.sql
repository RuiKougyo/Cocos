-- =============================================================================
-- シフト収集＆空き状況可視化システム 初期スキーマ
--   * 個人情報は members.display_name のみ（PIN はハッシュで保持し、個人情報ではない）
--   * スタッフは「店舗のグループ用URL」から 表示名＋4桁PIN で自己登録 → 店長が1回だけ承認
--   * 全テーブル RLS 有効。anon には権限を付与しない
--   * 書き込みは原則 SECURITY DEFINER の RPC 関数経由（search_path は空に固定）
--   * 他スタッフの空き状況は availability_board() でのみ公開（名前と時間帯だけ。備考は非公開）
--   * 営業日は 06:00〜翌 02:00。時刻は「営業日 0:00 からの分」で保持する
--     （06:00 = 360, 24:00 = 1440, 翌 01:30 = 1530, 翌 02:00 = 1560）
--   設計の背景は docs/design.md を参照
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- 型
-- -----------------------------------------------------------------------------
create type public.member_role   as enum ('admin', 'staff');
create type public.member_status as enum ('pending', 'active', 'retired');
create type public.period_status as enum ('draft', 'open', 'closed');

-- -----------------------------------------------------------------------------
-- テーブル
-- -----------------------------------------------------------------------------
create table public.stores (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 50),
  created_at timestamptz not null default now()
);

-- グループチャットに貼る店舗共通URLのコード（管理者のみ参照可。漏えい時は再発行）
create table public.store_join_codes (
  store_id   uuid primary key references public.stores (id) on delete cascade,
  code       text not null unique,
  rotated_at timestamptz not null default now()
);

create table public.members (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references public.stores (id) on delete cascade,
  user_id          uuid unique references auth.users (id) on delete set null,
  display_name     text not null check (char_length(btrim(display_name)) between 1 and 20),
  role             public.member_role   not null default 'staff',
  status           public.member_status not null default 'pending',
  pin_hash         text,                 -- bcrypt。NULL = 店長がリセット済み（次回ログインで再設定）
  failed_pin_count smallint not null default 0,
  locked_until     timestamptz,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  approved_at      timestamptz,
  retired_at       timestamptz,
  check ((status = 'retired') = (retired_at is not null)),
  check (status <> 'retired' or user_id is null)
);
create index members_store_id_idx on public.members (store_id);
-- PIN ログインは「表示名」で本人を特定するため、店舗内で表示名を一意にする
create unique index members_store_name_uniq
  on public.members (store_id, lower(btrim(display_name)))
  where status <> 'retired';

create table public.shift_periods (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  label      text not null check (char_length(btrim(label)) between 1 and 30),
  start_date date not null,
  end_date   date not null,
  deadline   timestamptz,
  status     public.period_status not null default 'draft',
  -- タイムラインの表示範囲（営業日 0:00 からの分。既定 06:00〜翌 02:00）
  view_start_min smallint not null default 360,
  view_end_min   smallint not null default 1560,
  created_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date < 32),
  check (view_start_min >= 360 and view_end_min <= 1560 and view_start_min < view_end_min
         and view_start_min % 5 = 0 and view_end_min % 5 = 0)
);
create index shift_periods_store_id_idx on public.shift_periods (store_id);

create table public.submissions (
  id           uuid primary key default gen_random_uuid(),
  period_id    uuid not null references public.shift_periods (id) on delete cascade,
  member_id    uuid not null references public.members (id) on delete cascade,
  note         text check (char_length(note) <= 500),
  submitted_at timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (period_id, member_id)
);
create index submissions_member_id_idx on public.submissions (member_id);

-- work_date は営業日（その日の 06:00 が属する日付）。10/3 23:00〜翌 1:00 は work_date=10/3 に入る
create table public.submission_days (
  submission_id uuid not null references public.submissions (id) on delete cascade,
  work_date     date not null,
  is_available  boolean not null,
  start_min     smallint,  -- 360 (06:00) 〜 1555 (翌 01:55)
  end_min       smallint,  -- 365 (06:05) 〜 1560 (翌 02:00)
  note          text check (char_length(note) <= 200),
  primary key (submission_id, work_date),
  check (
    (not is_available and start_min is null and end_min is null)
    or (
      is_available
      and start_min is not null and end_min is not null
      and start_min >= 360 and end_min <= 1560
      and start_min < end_min
      and start_min % 5 = 0 and end_min % 5 = 0
    )
  )
);

-- 確定シフト（店長がタイムライン上で割り当てる）。1人1営業日1枠
create table public.shift_assignments (
  period_id  uuid not null references public.shift_periods (id) on delete cascade,
  member_id  uuid not null references public.members (id) on delete cascade,
  work_date  date not null,
  start_min  smallint not null,
  end_min    smallint not null,
  updated_at timestamptz not null default now(),
  primary key (member_id, work_date),
  check (start_min >= 360 and end_min <= 1560 and start_min < end_min
         and start_min % 5 = 0 and end_min % 5 = 0)
);
create index shift_assignments_period_idx on public.shift_assignments (period_id, work_date);

-- 改善要望は匿名（投稿者を保持しない）
create table public.feedback (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index feedback_store_id_idx on public.feedback (store_id, created_at desc);

-- 監査ログ（対象者の氏名は記録しない）
create table public.audit_logs (
  id              bigint generated always as identity primary key,
  store_id        uuid not null references public.stores (id) on delete cascade,
  actor_member_id uuid references public.members (id) on delete set null,
  action          text not null,
  target_id       uuid,
  created_at      timestamptz not null default now()
);
create index audit_logs_store_id_idx on public.audit_logs (store_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 権限判定ヘルパー（RLS から呼ぶ）
-- -----------------------------------------------------------------------------
-- 承認済み（active）メンバーとしての自分
create function public.my_member_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.members m
  where m.user_id = auth.uid() and m.status = 'active'
$$;

create function public.my_store_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.store_id from public.members m
  where m.user_id = auth.uid() and m.status = 'active'
$$;

-- 管理者権限は MFA 済みセッション (aal2) の場合のみ有効
create function public.is_store_admin(p_store_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (
       select 1 from public.members m
       where m.user_id = auth.uid()
         and m.store_id = p_store_id
         and m.role = 'admin'
         and m.status = 'active'
     )
$$;

create function public.is_period_admin(p_period_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shift_periods p
    where p.id = p_period_id and public.is_store_admin(p.store_id)
  )
$$;

-- 確定シフトの整合性: 期間・メンバーが同じ店舗で、日付が期間内か
create function public.assignment_valid(p_period_id uuid, p_member_id uuid, p_work_date date)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.shift_periods p
    join public.members m on m.store_id = p.store_id
    where p.id = p_period_id
      and m.id = p_member_id
      and m.role = 'staff'
      and m.status = 'active'
      and p_work_date between p.start_date and p.end_date
      and public.is_store_admin(p.store_id)
  )
$$;

-- RPC 内部用: 呼び出し元が管理者であることを確認し、その member 行を返す
create function public.require_admin() returns public.members
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.members;
begin
  select * into v_me from public.members m
  where m.user_id = auth.uid() and m.status = 'active' and m.role = 'admin';
  if v_me.id is null or not public.is_store_admin(v_me.store_id) then
    raise exception 'admin (MFA) required' using errcode = '42501';
  end if;
  return v_me;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.stores            enable row level security;
alter table public.store_join_codes  enable row level security;
alter table public.members           enable row level security;
alter table public.shift_periods     enable row level security;
alter table public.submissions       enable row level security;
alter table public.submission_days   enable row level security;
alter table public.shift_assignments enable row level security;
alter table public.feedback          enable row level security;
alter table public.audit_logs        enable row level security;

create policy stores_select on public.stores
  for select to authenticated
  using (id = public.my_store_id());

create policy store_join_codes_select on public.store_join_codes
  for select to authenticated
  using (public.is_store_admin(store_id));

-- 自分の行は承認待ちでも読める（状態表示のため）
create policy members_select on public.members
  for select to authenticated
  using (user_id = auth.uid() or public.is_store_admin(store_id));

create policy members_update on public.members
  for update to authenticated
  using (public.is_store_admin(store_id))
  with check (public.is_store_admin(store_id));

create policy shift_periods_select on public.shift_periods
  for select to authenticated
  using (
    public.is_store_admin(store_id)
    or (store_id = public.my_store_id() and status <> 'draft')
  );

create policy shift_periods_insert on public.shift_periods
  for insert to authenticated
  with check (public.is_store_admin(store_id));

create policy shift_periods_update on public.shift_periods
  for update to authenticated
  using (public.is_store_admin(store_id))
  with check (public.is_store_admin(store_id));

create policy shift_periods_delete on public.shift_periods
  for delete to authenticated
  using (public.is_store_admin(store_id));

create policy submissions_select on public.submissions
  for select to authenticated
  using (member_id = public.my_member_id() or public.is_period_admin(period_id));

-- 親の submissions が見える場合のみ（サブクエリにも RLS が適用される）
create policy submission_days_select on public.submission_days
  for select to authenticated
  using (exists (select 1 from public.submissions s where s.id = submission_id));

create policy shift_assignments_select on public.shift_assignments
  for select to authenticated
  using (member_id = public.my_member_id() or public.is_period_admin(period_id));

create policy shift_assignments_insert on public.shift_assignments
  for insert to authenticated
  with check (public.assignment_valid(period_id, member_id, work_date));

create policy shift_assignments_update on public.shift_assignments
  for update to authenticated
  using (public.is_period_admin(period_id))
  with check (public.assignment_valid(period_id, member_id, work_date));

create policy shift_assignments_delete on public.shift_assignments
  for delete to authenticated
  using (public.is_period_admin(period_id));

create policy feedback_select on public.feedback
  for select to authenticated
  using (public.is_store_admin(store_id));

create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (public.is_store_admin(store_id));

-- -----------------------------------------------------------------------------
-- テーブル権限（Supabase 既定の広い GRANT を取り消し、必要最小限だけ付与）
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

grant select on
  public.stores, public.store_join_codes, public.shift_periods, public.submissions,
  public.submission_days, public.shift_assignments, public.feedback, public.audit_logs
to authenticated;

-- members は PIN 関連の列を誰にも読ませない（列単位 GRANT）
grant select (id, store_id, user_id, display_name, role, status, sort_order,
              created_at, approved_at, retired_at, locked_until)
  on public.members to authenticated;
grant update (display_name, sort_order) on public.members to authenticated;

grant insert, update, delete on public.shift_periods to authenticated;
grant insert, update, delete on public.shift_assignments to authenticated;

-- -----------------------------------------------------------------------------
-- RPC: 内部ユーティリティ
-- -----------------------------------------------------------------------------
create function public.log_action(p_store_id uuid, p_actor uuid, p_action text, p_target uuid)
returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs (store_id, actor_member_id, action, target_id)
  values (p_store_id, p_actor, p_action, p_target)
$$;

-- 推測不能な URL 用コード（128bit, 32 文字の 16 進）
create function public.new_join_code() returns text
language sql volatile security definer set search_path = '' as $$
  select encode(extensions.gen_random_bytes(16), 'hex')
$$;

create function public.store_id_by_code(p_code text) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.store_id from public.store_join_codes c where c.code = p_code
$$;

create function public.check_pin_format(p_pin text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    raise exception 'PIN must be 4 digits' using errcode = '22023';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- RPC: グループ用URLからの登録・ログイン（スタッフ）
--   クライアントは URL を開いた時点で匿名サインイン（Turnstile 付き）してから呼ぶ。
--   結果は例外ではなく状態文字列で返す（失敗回数の記録をロールバックさせないため）。
-- -----------------------------------------------------------------------------
-- URL のコードから店舗名を引く（登録画面の表示用）
create function public.store_by_code(p_code text)
returns table (store_id uuid, store_name text)
language sql stable security definer set search_path = '' as $$
  select s.id, s.name
  from public.store_join_codes c join public.stores s on s.id = c.store_id
  where c.code = p_code and auth.uid() is not null
$$;

-- はじめての登録: 'pending' | 'name_taken' | 'already_linked' | 'invalid_code' | 'too_many_pending'
create function public.register_member(p_code text, p_display_name text, p_pin text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_store_id uuid := public.store_id_by_code(p_code);
  v_name     text := btrim(p_display_name);
  v_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'sign-in required' using errcode = '42501';
  end if;
  perform public.check_pin_format(p_pin);
  if v_store_id is null then
    return 'invalid_code';
  end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    return 'already_linked';
  end if;
  -- URL が外部に漏れた場合の大量登録を抑止
  if (select count(*) from public.members
      where store_id = v_store_id and status = 'pending') >= 20 then
    return 'too_many_pending';
  end if;
  if exists (select 1 from public.members
             where store_id = v_store_id and status <> 'retired'
               and lower(btrim(display_name)) = lower(v_name)) then
    return 'name_taken';
  end if;

  insert into public.members (store_id, user_id, display_name, role, status, pin_hash, sort_order)
  values (
    v_store_id, auth.uid(), v_name, 'staff', 'pending',
    extensions.crypt(p_pin, extensions.gen_salt('bf', 8)),
    coalesce((select max(m.sort_order) + 1 from public.members m where m.store_id = v_store_id), 0)
  )
  returning id into v_id;

  perform public.log_action(v_store_id, v_id, 'member.register', v_id);
  return 'pending';
end;
$$;

-- 機種変更・ブラウザのデータ消去後のログイン:
--   'ok' | 'pending' | 'locked' | 'invalid' | 'already_linked' | 'invalid_code'
--   PIN を 5 回間違えると 30 分ロック、累計 10 回で店長のリセットまでロック
create function public.login_member(p_code text, p_display_name text, p_pin text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_store_id uuid := public.store_id_by_code(p_code);
  v_m        public.members;
begin
  if auth.uid() is null then
    raise exception 'sign-in required' using errcode = '42501';
  end if;
  perform public.check_pin_format(p_pin);
  if v_store_id is null then
    return 'invalid_code';
  end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    return 'already_linked';
  end if;

  select * into v_m from public.members
  where store_id = v_store_id and role = 'staff' and status in ('pending', 'active')
    and lower(btrim(display_name)) = lower(btrim(p_display_name))
  for update;
  if v_m.id is null then
    return 'invalid';
  end if;
  if v_m.locked_until is not null and v_m.locked_until > now() then
    return 'locked';
  end if;

  if v_m.pin_hash is null then
    -- 店長が PIN をリセット済み: 新しい PIN を設定し、再承認待ちにする
    update public.members
    set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)),
        user_id = auth.uid(), status = 'pending',
        failed_pin_count = 0, locked_until = null
    where id = v_m.id;
    perform public.log_action(v_m.store_id, v_m.id, 'member.pin_reset_claim', v_m.id);
    return 'pending';
  end if;

  if extensions.crypt(p_pin, v_m.pin_hash) <> v_m.pin_hash then
    update public.members
    set failed_pin_count = failed_pin_count + 1,
        locked_until = case
          when failed_pin_count + 1 >= 10 then 'infinity'::timestamptz
          when (failed_pin_count + 1) % 5 = 0 then now() + interval '30 minutes'
          else locked_until end
    where id = v_m.id;
    perform public.log_action(v_m.store_id, null, 'member.login_failed', v_m.id);
    return 'invalid';
  end if;

  -- 成功: この端末に付け替える（旧端末は自動的にログアウト扱い）
  update public.members
  set user_id = auth.uid(), failed_pin_count = 0, locked_until = null
  where id = v_m.id;
  perform public.log_action(v_m.store_id, v_m.id, 'member.login', v_m.id);
  return case when v_m.status = 'active' then 'ok' else 'pending' end;
end;
$$;

-- この端末からログアウト（共用端末向け）
create function public.logout_member() returns void
language sql security definer set search_path = '' as $$
  update public.members set user_id = null
  where user_id = auth.uid() and role = 'staff'
$$;

-- -----------------------------------------------------------------------------
-- RPC: 店舗・メンバー管理（管理者）
-- -----------------------------------------------------------------------------
-- 初期設定: 運営が発行した管理者アカウントが MFA 登録後に一度だけ呼ぶ
create function public.create_store(p_store_name text, p_admin_display_name text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store_id  uuid;
  v_member_id uuid;
begin
  if auth.uid() is null
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
     or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'non-anonymous MFA session required' using errcode = '42501';
  end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'already belongs to a store' using errcode = '42501';
  end if;

  insert into public.stores (name) values (btrim(p_store_name)) returning id into v_store_id;
  insert into public.store_join_codes (store_id, code) values (v_store_id, public.new_join_code());
  insert into public.members (store_id, user_id, display_name, role, status, approved_at)
  values (v_store_id, auth.uid(), btrim(p_admin_display_name), 'admin', 'active', now())
  returning id into v_member_id;

  perform public.log_action(v_store_id, v_member_id, 'store.create', v_store_id);
  return v_store_id;
end;
$$;

-- グループ用URLの再発行（URL が店外に漏れた場合）。旧URLは即無効
create function public.rotate_join_code() returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me   public.members := public.require_admin();
  v_code text := public.new_join_code();
begin
  update public.store_join_codes set code = v_code, rotated_at = now()
  where store_id = v_me.store_id;
  perform public.log_action(v_me.store_id, v_me.id, 'join_code.rotate', v_me.store_id);
  return v_code;
end;
$$;

create function public.approve_member(p_member_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.members := public.require_admin();
begin
  update public.members set status = 'active', approved_at = now()
  where id = p_member_id and store_id = v_me.store_id and status = 'pending' and role = 'staff';
  if not found then
    raise exception 'pending member not found' using errcode = 'P0002';
  end if;
  perform public.log_action(v_me.store_id, v_me.id, 'member.approve', p_member_id);
end;
$$;

-- 心当たりのない登録申請を削除（一度も承認されていないもののみ）
create function public.reject_member(p_member_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.members := public.require_admin();
begin
  delete from public.members
  where id = p_member_id and store_id = v_me.store_id
    and status = 'pending' and approved_at is null and role = 'staff';
  if not found then
    raise exception 'pending member not found' using errcode = 'P0002';
  end if;
  perform public.log_action(v_me.store_id, v_me.id, 'member.reject', p_member_id);
end;
$$;

-- PIN 忘れ・ロック解除: 端末の紐付けと PIN を消す。本人が新しい PIN でログインし、再承認する
create function public.reset_member_login(p_member_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.members := public.require_admin();
begin
  update public.members
  set user_id = null, pin_hash = null, status = 'pending',
      failed_pin_count = 0, locked_until = null
  where id = p_member_id and store_id = v_me.store_id
    and role = 'staff' and status in ('pending', 'active');
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  perform public.log_action(v_me.store_id, v_me.id, 'member.reset_login', p_member_id);
end;
$$;

-- 退職処理: 即時にアクセス不能にする（30 日後に purge_expired_data で完全削除）
create function public.retire_member(p_member_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.members := public.require_admin();
begin
  if p_member_id = v_me.id then
    raise exception 'cannot retire yourself' using errcode = '22023';
  end if;

  update public.members
  set status = 'retired', user_id = null, retired_at = now()
  where id = p_member_id and store_id = v_me.store_id and status <> 'retired';
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;

  -- 未来の確定シフトは外す（代わり探しの画面に残さない）
  delete from public.shift_assignments
  where member_id = p_member_id and work_date >= current_date;
  perform public.log_action(v_me.store_id, v_me.id, 'member.retire', p_member_id);
end;
$$;

-- 退職処理の取り消し（本人は表示名＋PINで再ログインする）
create function public.restore_member(p_member_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.members := public.require_admin();
begin
  update public.members
  set status = 'active', retired_at = null
  where id = p_member_id and store_id = v_me.store_id and status = 'retired';
  if not found then
    raise exception 'retired member not found' using errcode = 'P0002';
  end if;
  perform public.log_action(v_me.store_id, v_me.id, 'member.restore', p_member_id);
end;
$$;

-- 退職処理済みメンバーを即時に完全削除（提出・確定シフトも連鎖削除）
create function public.delete_member_now(p_member_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.members := public.require_admin();
begin
  delete from public.members
  where id = p_member_id and store_id = v_me.store_id and status = 'retired';
  if not found then
    raise exception 'retired member not found (retire first)' using errcode = 'P0002';
  end if;
  perform public.log_action(v_me.store_id, v_me.id, 'member.delete', p_member_id);
end;
$$;

-- 未提出者一覧（SECURITY INVOKER: 呼び出し元の RLS がそのまま効く）
create function public.unsubmitted_members(p_period_id uuid)
returns table (member_id uuid, display_name text)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.display_name
  from public.shift_periods p
  join public.members m on m.store_id = p.store_id
  where p.id = p_period_id
    and public.is_store_admin(p.store_id)
    and m.role = 'staff'
    and m.status = 'active'
    and not exists (
      select 1 from public.submissions s
      where s.period_id = p.id and s.member_id = m.id
    )
  order by m.sort_order, m.display_name
$$;

-- -----------------------------------------------------------------------------
-- RPC: スタッフ
-- -----------------------------------------------------------------------------
-- シフト提出（期間単位で丸ごと置き換え）
-- p_days: [{"work_date":"2026-10-01","is_available":true,"start_min":1025,"end_min":1530,"note":"..."}, ...]
--   ↑ 17:05〜翌 01:30。分への変換はクライアントで行う（06:00 未満の時刻は翌日扱いで +1440）
create function public.submit_shift(p_period_id uuid, p_note text, p_days jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.members;
  v_period public.shift_periods;
  v_sub_id uuid;
begin
  select * into v_me from public.members
  where user_id = auth.uid() and status = 'active' and role = 'staff';
  if v_me.id is null then
    raise exception 'active staff required' using errcode = '42501';
  end if;

  select * into v_period from public.shift_periods
  where id = p_period_id and store_id = v_me.store_id;
  if v_period.id is null then
    raise exception 'period not found' using errcode = 'P0002';
  end if;
  if v_period.status <> 'open' or (v_period.deadline is not null and v_period.deadline < now()) then
    raise exception 'period is not accepting submissions' using errcode = '22023';
  end if;

  if jsonb_typeof(p_days) is distinct from 'array' or jsonb_array_length(p_days) > 32 then
    raise exception 'days must be an array (max 32)' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_days) as d (work_date date, is_available boolean)
    where d.work_date is null
       or d.is_available is null
       or d.work_date not between v_period.start_date and v_period.end_date
  ) then
    raise exception 'invalid day entry' using errcode = '22023';
  end if;

  insert into public.submissions (period_id, member_id, note)
  values (v_period.id, v_me.id, nullif(btrim(p_note), ''))
  on conflict (period_id, member_id)
  do update set note = excluded.note, updated_at = now()
  returning id into v_sub_id;

  delete from public.submission_days where submission_id = v_sub_id;

  -- 「休み」の日は時刻を捨てる（CHECK 制約と整合させる）
  insert into public.submission_days (submission_id, work_date, is_available, start_min, end_min, note)
  select v_sub_id, d.work_date, d.is_available,
         case when d.is_available then d.start_min end,
         case when d.is_available then d.end_min end,
         nullif(btrim(d.note), '')
  from jsonb_to_recordset(p_days)
       as d (work_date date, is_available boolean, start_min smallint, end_min smallint, note text);

  return v_sub_id;
end;
$$;

-- 空き状況ボード（代わりに出られる人を探す）:
--   同じ店舗の承認済みメンバー全員が閲覧可。公開するのは「表示名・入れる時間帯・確定シフト」だけで、
--   備考（日別・期間全体）は本人と店長以外には返さない。下書き期間は対象外。
create function public.availability_board(p_period_id uuid)
returns table (
  member_id    uuid,
  display_name text,
  sort_order   integer,
  is_me        boolean,
  work_date    date,
  avail_start  smallint,
  avail_end    smallint,
  assign_start smallint,
  assign_end   smallint
)
language sql stable security definer set search_path = '' as $$
  with period as (
    select p.* from public.shift_periods p
    where p.id = p_period_id
      and p.store_id = public.my_store_id()
      and p.status <> 'draft'
  ),
  avail as (
    select s.member_id, d.work_date, d.start_min, d.end_min
    from period p
    join public.submissions s on s.period_id = p.id
    join public.submission_days d on d.submission_id = s.id and d.is_available
  ),
  assign as (
    select a.member_id, a.work_date, a.start_min, a.end_min
    from period p
    join public.shift_assignments a on a.period_id = p.id
  )
  select m.id, m.display_name, m.sort_order, m.id = public.my_member_id(),
         coalesce(av.work_date, asg.work_date),
         av.start_min, av.end_min, asg.start_min, asg.end_min
  from avail av
  full join assign asg on asg.member_id = av.member_id and asg.work_date = av.work_date
  join public.members m on m.id = coalesce(av.member_id, asg.member_id)
  where m.status = 'active' and m.role = 'staff'
  order by 5, m.sort_order, m.display_name
$$;

-- 改善要望（匿名で保存）
create function public.submit_feedback(p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_store_id uuid := public.my_store_id();
begin
  if v_store_id is null then
    raise exception 'active member required' using errcode = '42501';
  end if;
  insert into public.feedback (store_id, body) values (v_store_id, btrim(p_body));
end;
$$;

-- -----------------------------------------------------------------------------
-- 保持期間を過ぎたデータの削除（pg_cron から日次実行）
-- -----------------------------------------------------------------------------
create function public.purge_expired_data() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.members
  where status = 'retired' and retired_at < now() - interval '30 days';

  -- 承認されないまま 30 日経った登録申請
  delete from public.members
  where status = 'pending' and approved_at is null and created_at < now() - interval '30 days';

  delete from public.shift_periods
  where end_date < current_date - 180;

  delete from public.feedback
  where created_at < now() - interval '1 year';

  delete from public.audit_logs
  where created_at < now() - interval '1 year';
end;
$$;

-- 有効化する場合（Supabase ダッシュボードで pg_cron 拡張を有効にした後）:
-- select cron.schedule('purge-expired-data', '0 18 * * *', 'select public.purge_expired_data()');  -- 毎日 03:00 JST

-- -----------------------------------------------------------------------------
-- 関数の実行権限（既定の PUBLIC 実行権を取り消し、必要なものだけ付与）
-- -----------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.my_member_id(),
  public.my_store_id(),
  public.is_store_admin(uuid),
  public.is_period_admin(uuid),
  public.assignment_valid(uuid, uuid, date),
  public.store_by_code(text),
  public.register_member(text, text, text),
  public.login_member(text, text, text),
  public.logout_member(),
  public.create_store(text, text),
  public.rotate_join_code(),
  public.approve_member(uuid),
  public.reject_member(uuid),
  public.reset_member_login(uuid),
  public.retire_member(uuid),
  public.restore_member(uuid),
  public.delete_member_now(uuid),
  public.unsubmitted_members(uuid),
  public.submit_shift(uuid, text, jsonb),
  public.availability_board(uuid),
  public.submit_feedback(text)
to authenticated;
-- require_admin / log_action / new_join_code / store_id_by_code / check_pin_format /
-- purge_expired_data は内部専用（付与しない）
