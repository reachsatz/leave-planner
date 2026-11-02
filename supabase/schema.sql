-- Leave Planner schema for Supabase.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- The first person to sign up becomes the manager; everyone after is an employee.

-- ---------------------------------------------------------------- tables

create table if not exists public.profiles (
  id               uuid primary key references auth.users on delete cascade,
  email            text not null,
  full_name        text not null default '',
  role             text not null default 'employee' check (role in ('employee', 'manager')),
  annual_allowance numeric(5,1) not null default 20 check (annual_allowance >= 0),
  created_at       timestamptz not null default now()
);

create table if not exists public.holidays (
  id           bigint generated always as identity primary key,
  holiday_date date not null unique,
  name         text not null
);

create table if not exists public.leave_requests (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  leave_type   text not null check (leave_type in ('annual', 'sick', 'personal', 'unpaid')),
  start_date   date not null,
  end_date     date not null,
  half_day     boolean not null default false,
  days         numeric(5,1) not null default 0,
  reason       text,
  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  manager_note text,
  reviewed_by  uuid references public.profiles (id),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  check (end_date >= start_date),
  check (not half_day or start_date = end_date)
);

create index if not exists leave_requests_user_idx  on public.leave_requests (user_id);
create index if not exists leave_requests_dates_idx on public.leave_requests (start_date, end_date);

-- ---------------------------------------------------------------- helpers

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'manager');
$$;

-- Weekdays between two dates (inclusive) that are not public holidays.
create or replace function public.working_days(p_start date, p_end date)
returns numeric language sql stable set search_path = public as $$
  select count(*)::numeric
  from generate_series(p_start, p_end, interval '1 day') as d
  where extract(isodow from d) < 6
    and not exists (select 1 from holidays h where h.holiday_date = d::date);
$$;

-- ---------------------------------------------------------------- triggers

-- Create a profile for every new auth user. First user becomes manager.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
    case when exists (select 1 from profiles) then 'employee' else 'manager' end
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Employees may only change their own name. Role and allowance are manager-only
-- (auth.uid() is null when run from the SQL editor, which is allowed).
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_manager() then
    new.role := old.role;
    new.annual_allowance := old.annual_allowance;
  end if;
  new.id := old.id;
  new.email := old.email;
  return new;
end $$;

drop trigger if exists guard_profile_update on public.profiles;
create trigger guard_profile_update
  before update on public.profiles
  for each row execute function public.guard_profile_update();

-- New requests: always pending, owned by the caller, day count computed here,
-- and no overlap with the caller's other live requests.
create or replace function public.prepare_leave_request()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.user_id := coalesce(auth.uid(), new.user_id);
  new.status := 'pending';
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.manager_note := null;
  new.days := working_days(new.start_date, new.end_date) * (case when new.half_day then 0.5 else 1 end);
  if new.days = 0 then
    raise exception 'The selected dates contain no working days';
  end if;

  if exists (
    select 1 from leave_requests r
    where r.user_id = new.user_id
      and r.status in ('pending', 'approved')
      and r.start_date <= new.end_date
      and r.end_date >= new.start_date
  ) then
    raise exception 'You already have leave booked that overlaps these dates';
  end if;
  return new;
end $$;

drop trigger if exists prepare_leave_request on public.leave_requests;
create trigger prepare_leave_request
  before insert on public.leave_requests
  for each row execute function public.prepare_leave_request();

-- Updates: managers approve/reject; employees can only cancel their own
-- pending or approved request, and nothing else about it changes.
create or replace function public.guard_leave_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if is_manager() then
    if new.status is distinct from old.status and new.status in ('approved', 'rejected') then
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    end if;
    return new;
  end if;

  if old.user_id <> auth.uid()
     or new.status <> 'cancelled'
     or old.status not in ('pending', 'approved') then
    raise exception 'You can only cancel your own pending or approved leave';
  end if;

  new := old;
  new.status := 'cancelled';
  return new;
end $$;

drop trigger if exists guard_leave_update on public.leave_requests;
create trigger guard_leave_update
  before update on public.leave_requests
  for each row execute function public.guard_leave_update();

-- ---------------------------------------------------------------- row level security

alter table public.profiles       enable row level security;
alter table public.holidays       enable row level security;
alter table public.leave_requests enable row level security;

drop policy if exists "profiles readable by team" on public.profiles;
create policy "profiles readable by team" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles editable by self or manager" on public.profiles;
create policy "profiles editable by self or manager" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_manager())
  with check (id = auth.uid() or public.is_manager());

drop policy if exists "holidays readable by team" on public.holidays;
create policy "holidays readable by team" on public.holidays
  for select to authenticated using (true);

drop policy if exists "holidays managed by managers" on public.holidays;
create policy "holidays managed by managers" on public.holidays
  for all to authenticated
  using (public.is_manager())
  with check (public.is_manager());

-- The whole team can see leave so the team calendar works.
drop policy if exists "leave readable by team" on public.leave_requests;
create policy "leave readable by team" on public.leave_requests
  for select to authenticated using (true);

drop policy if exists "leave created by owner" on public.leave_requests;
create policy "leave created by owner" on public.leave_requests
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "leave updated by owner or manager" on public.leave_requests;
create policy "leave updated by owner or manager" on public.leave_requests
  for update to authenticated
  using (user_id = auth.uid() or public.is_manager())
  with check (user_id = auth.uid() or public.is_manager());
