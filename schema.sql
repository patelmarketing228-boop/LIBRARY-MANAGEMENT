-- Run in Supabase SQL Editor. Creates the 75 seats, payment ledger, RLS policies and atomic renewal RPC.
create table if not exists public.seats (
  seat_number integer primary key check (seat_number between 1 and 75),
  status text not null default 'vacant' check (status in ('vacant','occupied')),
  student_name text,
  phone text,
  expiry_date date,
  constraint occupied_has_student check (status <> 'occupied' or (student_name is not null and phone is not null and expiry_date is not null))
);
insert into public.seats (seat_number,status) select n,'vacant' from generate_series(1,75) n on conflict (seat_number) do nothing;

create table if not exists public.renewal_payments (
  payment_id text primary key,
  order_id text not null,
  seat_number integer not null references public.seats(seat_number),
  plan_days integer not null check (plan_days in (30,90)),
  amount_paise integer not null,
  created_at timestamptz not null default now()
);

alter table public.seats enable row level security;
alter table public.renewal_payments enable row level security;
-- The student portal reads one seat through the Worker (service role), not direct public table access.
-- Admins can read/manage the seat table through authenticated RLS.
drop policy if exists "Admins can manage seats" on public.seats;
create policy "Admins can manage seats" on public.seats for all to authenticated
 using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
 with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
-- No client-side policies on renewal_payments: only the Worker service role can write/read it.
revoke all on public.renewal_payments from anon, authenticated;

create or replace function public.renew_seat_payment(
 p_payment_id text,p_order_id text,p_seat_number integer,p_days integer,p_amount integer
) returns table(expiry_date date)
language plpgsql security definer set search_path=public as $$
declare v_expiry date; v_inserted integer;
begin
 if p_days not in (30,90) or p_seat_number not between 1 and 75 then raise exception 'Invalid plan or seat'; end if;
 -- Lock seat row to serialize concurrent renewals.
 perform 1 from public.seats where seat_number=p_seat_number and status='occupied' for update;
 if not found then raise exception 'Seat is not occupied'; end if;
 insert into public.renewal_payments(payment_id,order_id,seat_number,plan_days,amount_paise)
 values(p_payment_id,p_order_id,p_seat_number,p_days,p_amount) on conflict(payment_id) do nothing;
 get diagnostics v_inserted = row_count;
 if v_inserted=0 then
   select s.expiry_date into v_expiry from public.seats s where s.seat_number=p_seat_number;
   return query select v_expiry; return;
 end if;
 update public.seats s set expiry_date=(greatest(coalesce(s.expiry_date,current_date),current_date)+p_days)
 where s.seat_number=p_seat_number returning s.expiry_date into v_expiry;
 return query select v_expiry;
end; $$;
revoke all on function public.renew_seat_payment(text,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.renew_seat_payment(text,text,integer,integer,integer) to service_role;
