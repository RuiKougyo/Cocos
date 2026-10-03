-- =============================================================================
-- シフト収集＆空き状況可視化システム 初期スキーマ
--   * 個人情報は members.display_name のみ
--   * 全テーブル RLS 有効。anon には権限を付与しない
--   * 書き込みは原則 SECURITY DEFINER の RPC 関数経由（search_path は空に固定）
--   設計の背景は docs/design.md を参照
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- 型
-- -----------------------------------------------------------------------------
create type public.member_role   as enum ('admin', 'staff');
create type public.member_status as enum ('invited', 'active', 'retired');
create type public.period_status as enum ('draft', 'open', 'closed');

-- -----------------------------------------------------------------------------
-- テーブル
-- -----------------------------------------------------------------------------
create table public.stores (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 50),
  created_at timestamptz not null default now()
);

create table public.members (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores (id) on delete cascade,
  user_id      uuid unique references auth.users (id) on delete set null,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 20),
  role         public.member_role   not null default 'staff',
  status       public.member_status not null default 'invited',
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  retired_at   timestamptz,
  check ((status = 'retired') = (retired_at is not null)),
  check (status = 'active' or user_id is null)
);
create index members_store_id_idx on public.members (store_id);

create table public.invitations (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references public.members (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index invitations_member_id_idx on public.invitations (member_id);

create table public.shift_periods (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  label      text not null check (char_length(btrim(label)) between 1 and 30),
  start_date date not null,
  end_date   date not null,
  deadline   timestamptz,
  status     public.period_status not null default 'draft',
  view_start time not null default '09:00',
  view_end   time not null default '22:00',
  created_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date < 32),
  check (view_start < view_end)
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

create table public.submission_days (
  submission_id uuid not null references public.submissions (id) on delete cascade,
  work_date     date not null,
  is_available  boolean not null,
  start_time    time,
  end_time      time,
  note          text check (char_length(note) <= 200),
  primary key (submission_id, work_date),
  check (
    (not is_available and start_time is null and end_time is null)
    or (
      is_available
      and start_time is not null and end_time is not null
      and start_time < end_time
      and extract(minute from start_time)::int % 5 = 0
      and extract(minute from end_time)::int % 5 = 0
      and extract(second from start_time) = 0
      and extract(second from end_time) = 0
    )
  )
);

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
alter table public.stores          enable row level security;
alter table public.members         enable row level security;
alter table public.invitations     enable row level security;
alter table public.shift_periods   enable row level security;
alter table public.submissions     enable row level security;
alter table public.submission_days enable row level security;
alter table public.feedback        enable row level security;
alter table public.audit_logs      enable row level security;

create policy stores_select on public.stores
  for select to authenticated
  using (id = public.my_store_id());

create policy members_select on public.members
  for select to authenticated
  using (id = public.my_member_id() or public.is_store_admin(store_id));

create policy members_update on public.members
  for update to authenticated
  using (public.is_store_admin(store_id))
  with check (public.is_store_admin(store_id));

-- invitations: ポリシーなし = 全拒否（RPC のみ）

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
  public.stores, public.members, public.shift_periods, public.submissions,
  public.submission_days, public.feedback, public.audit_logs
to authenticated;

grant insert, update, delete on public.shift_periods to authenticated;
grant update (display_name, sort_order) on public.members to authenticated;

-- -----------------------------------------------------------------------------
-- RPC: 内部ユーティリティ
-- -----------------------------------------------------------------------------
create function public.log_action(p_store_id uuid, p_actor uuid, p_action text, p_target uuid)
returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs (store_id, actor_member_id, action, target_id)
  values (p_store_id, p_actor, p_action, p_target)
$$;

-- 招待トークンを発行し平文を返す（DB にはハッシュのみ保存）
create function public.new_invitation(p_member_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  delete from public.invitations where member_id = p_member_id and used_at is null;
  insert into public.invitations (member_id, token_hash, expires_at)
  values (
    p_member_id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    now() + interval '72 hours'
  );
  return v_token;
end;
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
  insert into public.members (store_id, user_id, display_name, role, status)
  values (v_store_id, auth.uid(), btrim(p_admin_display_name), 'admin', 'active')
  returning id into v_member_id;

  perform public.log_action(v_store_id, v_member_id, 'store.create', v_store_id);
  return v_store_id;
end;
$$;

-- スタッフを追加し、招待トークン（平文）を返す
create function public.add_staff(p_display_name text)
returns table (member_id uuid, token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.members := public.require_admin();
  v_id uuid;
begin
  insert into public.members (store_id, display_name, role, status, sort_order)
  values (
    v_me.store_id, btrim(p_display_name), 'staff', 'invited',
    coalesce((select max(m.sort_order) + 1 from public.members m where m.store_id = v_me.store_id), 0)
  )
  returning id into v_id;

  perform public.log_action(v_me.store_id, v_me.id, 'member.add', v_id);
  return query select v_id, public.new_invitation(v_id);
end;
$$;

-- 招待の再発行（機種変更など）。旧端末の紐付けは即時解除される
create function public.issue_invitation(p_member_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.members := public.require_admin();
  v_target public.members;
begin
  select * into v_target from public.members
  where id = p_member_id and store_id = v_me.store_id and role = 'staff'
  for update;
  if v_target.id is null then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_target.status = 'retired' then
    raise exception 'member is retired' using errcode = '22023';
  end if;

  update public.members set user_id = null, status = 'invited' where id = v_target.id;
  perform public.log_action(v_me.store_id, v_me.id, 'invitation.issue', v_target.id);
  return public.new_invitation(v_target.id);
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

  delete from public.invitations where member_id = p_member_id;
  perform public.log_action(v_me.store_id, v_me.id, 'member.retire', p_member_id);
end;
$$;

-- 退職処理の取り消し（招待を再発行して返す）
create function public.restore_member(p_member_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.members := public.require_admin();
begin
  update public.members
  set status = 'invited', retired_at = null
  where id = p_member_id and store_id = v_me.store_id and status = 'retired';
  if not found then
    raise exception 'retired member not found' using errcode = 'P0002';
  end if;

  perform public.log_action(v_me.store_id, v_me.id, 'member.restore', p_member_id);
  return public.new_invitation(p_member_id);
end;
$$;

-- 退職処理済みメンバーを即時に完全削除（提出データも連鎖削除）
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
returns table (member_id uuid, display_name text, status public.member_status)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.display_name, m.status
  from public.shift_periods p
  join public.members m on m.store_id = p.store_id
  where p.id = p_period_id
    and public.is_store_admin(p.store_id)
    and m.role = 'staff'
    and m.status in ('invited', 'active')
    and not exists (
      select 1 from public.submissions s
      where s.period_id = p.id and s.member_id = m.id
    )
  order by m.sort_order, m.display_name
$$;

-- -----------------------------------------------------------------------------
-- RPC: スタッフ
-- -----------------------------------------------------------------------------
-- 招待リンクの受け取り（匿名サインイン直後に呼ぶ）
create function public.redeem_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_inv    public.invitations;
  v_member public.members;
begin
  if auth.uid() is null then
    raise exception 'sign-in required' using errcode = '42501';
  end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'this device is already linked' using errcode = '22023';
  end if;

  select * into v_inv from public.invitations
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
  for update;
  if v_inv.id is null or v_inv.used_at is not null or v_inv.expires_at < now() then
    raise exception 'invitation is invalid, used or expired' using errcode = '22023';
  end if;

  select * into v_member from public.members where id = v_inv.member_id for update;
  if v_member.status <> 'invited' then
    raise exception 'invitation is invalid, used or expired' using errcode = '22023';
  end if;
  if v_member.role = 'admin' and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'admin cannot sign in anonymously' using errcode = '42501';
  end if;

  update public.invitations set used_at = now() where id = v_inv.id;
  update public.members set user_id = auth.uid(), status = 'active' where id = v_member.id;
  perform public.log_action(v_member.store_id, v_member.id, 'invitation.redeem', v_member.id);
  return v_member.id;
end;
$$;

-- シフト提出（期間単位で丸ごと置き換え）
-- p_days: [{"work_date":"2026-10-01","is_available":true,"start_time":"17:05","end_time":"22:00","note":"..."}, ...]
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
  insert into public.submission_days (submission_id, work_date, is_available, start_time, end_time, note)
  select v_sub_id, d.work_date, d.is_available,
         case when d.is_available then d.start_time end,
         case when d.is_available then d.end_time end,
         nullif(btrim(d.note), '')
  from jsonb_to_recordset(p_days)
       as d (work_date date, is_available boolean, start_time time, end_time time, note text);

  return v_sub_id;
end;
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

  delete from public.shift_periods
  where end_date < current_date - 180;

  delete from public.feedback
  where created_at < now() - interval '1 year';

  delete from public.invitations
  where used_at is null and expires_at < now();

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
  public.create_store(text, text),
  public.add_staff(text),
  public.issue_invitation(uuid),
  public.retire_member(uuid),
  public.restore_member(uuid),
  public.delete_member_now(uuid),
  public.unsubmitted_members(uuid),
  public.redeem_invitation(text),
  public.submit_shift(uuid, text, jsonb),
  public.submit_feedback(text)
to authenticated;
-- require_admin / log_action / new_invitation / purge_expired_data は内部専用（付与しない）
