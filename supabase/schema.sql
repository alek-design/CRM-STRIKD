-- STRIKD Growth · esquema de Supabase
-- Córrelo una vez en Supabase → SQL Editor → New query → Run.

-- ============ Usuarios y roles ============
create table if not exists public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text,
  role text not null default 'none' check (role in ('head','manager','am','none')),
  active boolean not null default true,
  invited_by uuid,
  created_at timestamptz not null default now()
);
-- invitaciones pendientes (antes de que la persona cree su cuenta)
create table if not exists public.invites (
  email text primary key,
  name text,
  role text not null check (role in ('manager','am')),
  invited_by uuid,
  created_at timestamptz not null default now()
);

-- nivel de acceso del usuario actual: 0 nada · 2 account manager · 3 manager · 4 head
create or replace function public.user_level() returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select case role when 'head' then 4 when 'manager' then 3 when 'am' then 2 else 0 end
                   from app_users where id = auth.uid() and active), 0);
$$;

-- al crear una cuenta: el primero en entrar es el Head; los demás toman el rol de su invitación
create or replace function public.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv invites%rowtype; r text := 'none';
begin
  if not exists (select 1 from app_users where role = 'head') then r := 'head';
  else
    select * into inv from invites where lower(email) = lower(new.email);
    if found then r := inv.role; end if;
  end if;
  insert into app_users (id, email, name, role, invited_by)
  values (new.id, new.email, coalesce(inv.name, new.raw_user_meta_data->>'name', split_part(new.email,'@',1)), r, inv.invited_by)
  on conflict (id) do nothing;
  if r = 'manager' then
    insert into docs(path, data) values ('roles/' || new.id::text, jsonb_build_object('role','manager','updatedAt', (extract(epoch from now())*1000)::bigint))
    on conflict (path) do nothing;
  end if;
  delete from invites where lower(email) = lower(new.email);
  return new;
end $$;
drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created after insert on auth.users for each row execute function public.on_auth_user_created();

alter table app_users enable row level security;
alter table invites enable row level security;
drop policy if exists app_users_read on app_users;
create policy app_users_read on app_users for select using (user_level() >= 2 or id = auth.uid());
drop policy if exists invites_read on invites;
create policy invites_read on invites for select using (user_level() >= 4);

-- ============ Documentos (misma estructura que el tablero) ============
create table if not exists public.docs (
  path text primary key,
  parent text generated always as (regexp_replace(path, '/[^/]+$', '')) stored,
  id text generated always as (regexp_replace(path, '^.*/', '')) stored,
  data jsonb not null default '{}'::jsonb,
  version int not null default 1,
  updated_at timestamptz not null default now()
);
create index if not exists docs_parent_idx on docs(parent);
alter table docs replica identity full;

-- quién puede leer/escribir cada ruta (las mismas reglas que tenía el artifact)
create or replace function public.doc_allowed(p text, op text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare seg text[] := string_to_array(p, '/'); lvl int := user_level(); me text := auth.uid()::text; need int;
begin
  if lvl = 0 then return false; end if;
  -- Influencer Outreach (Mich): ve y actualiza la Lista de influencers de todo el equipo
  if seg[1] = 'meets' and seg[3] = 'vip' and exists (select 1 from docs d where d.path = 'roles/' || me and d.data->>'role' = 'influencer') then
    return lvl >= 2;
  end if;
  -- Influencer Outreach: consulta (solo lectura) los prospectos y tareas del equipo para ver Equipo (team-ro-v1)
  if seg[1] = 'meets' and op = 'read' and exists (select 1 from docs d where d.path = 'roles/' || me and d.data->>'role' = 'influencer') then
    return lvl >= 2;
  end if;
  -- AM con permiso del Head ("Puede asignar tareas") o Influencer Outreach: crean y revisan tareas del equipo (tasks-v2)
  if seg[1] = 'meets' and seg[3] = 'tasks' and exists (select 1 from docs d where d.path = 'roles/' || me and ((d.data->>'canAssign')::boolean is true or d.data->>'role' = 'influencer')) then
    return lvl >= 2;
  end if;
  if seg[1] in ('meets','members','points') and seg[2] = me then
    need := case when op = 'read' and seg[1] in ('members','points') then 1 else 2 end;
  else
    need := case seg[1]
      when 'meets'         then 3
      when 'members'       then case when op = 'read' then 1 else 4 end
      when 'validations'   then case when op = 'read' then 1 else 3 end
      when 'points'        then case when op = 'read' then 1 else 3 end
      when 'roles'         then case when op = 'read' then 1 else 4 end
      when 'vipIndex'      then 2
      when 'prospectIndex' then 2
      when 'waCampaigns'   then 3
      when 'taskRules'     then 3
      when 'emailTpl'      then case when op = 'read' then 2 else 3 end -- plantillas de email automático (email-v1)
      when 'waTemplates'   then case when op = 'read' then 2 else 3 end
      when 'config'        then case when op = 'read' then 1 else 4 end
      else 4 end;
  end if;
  return lvl >= need;
end $$;

alter table docs enable row level security;
drop policy if exists docs_read on docs;   create policy docs_read   on docs for select using (doc_allowed(path, 'read'));
drop policy if exists docs_insert on docs; create policy docs_insert on docs for insert with check (doc_allowed(path, 'write'));
drop policy if exists docs_update on docs; create policy docs_update on docs for update using (doc_allowed(path, 'write')) with check (doc_allowed(path, 'write'));
drop policy if exists docs_delete on docs; create policy docs_delete on docs for delete using (doc_allowed(path, 'write'));

-- merge profundo (objetos se combinan, arreglos se reemplazan), como update() del tablero
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k,
    case when jsonb_typeof(a->k) = 'object' and jsonb_typeof(b->k) = 'object' then jsonb_deep_merge(a->k, b->k)
         when b ? k then b->k else a->k end), '{}'::jsonb)
  from (select jsonb_object_keys(coalesce(a,'{}'::jsonb)) k union select jsonb_object_keys(coalesce(b,'{}'::jsonb))) keys;
$$;
create or replace function public.doc_update(p text, patch jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare v int;
begin
  update docs set data = jsonb_deep_merge(data, patch), version = version + 1, updated_at = now() where path = p returning version into v;
  if v is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  return v;
end $$;

-- cambiar el rol en el Organigrama también cambia el acceso real
create or replace function public.sync_role_doc() returns trigger
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if new.path like 'roles/%' then
    begin uid := split_part(new.path, '/', 2)::uuid; exception when others then return new; end;
    update app_users set role = case when new.data->>'role' = 'manager' then 'manager' else 'am' end
      where id = uid and role <> 'head';
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_role on docs;
create trigger trg_sync_role after insert or update on docs for each row execute function public.sync_role_doc();

-- tiempo real
do $$ begin
  begin alter publication supabase_realtime add table public.docs; exception when duplicate_object then null; end;
end $$;

-- ============ Archivos (skeletons y PDFs de plantillas) ============
insert into storage.buckets (id, name, public) values ('assets', 'assets', true) on conflict (id) do nothing;
drop policy if exists assets_upload on storage.objects;
create policy assets_upload on storage.objects for insert to authenticated with check (bucket_id = 'assets' and public.user_level() >= 3);
drop policy if exists assets_delete on storage.objects;
create policy assets_delete on storage.objects for delete to authenticated using (bucket_id = 'assets' and public.user_level() >= 3);
