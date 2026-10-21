// Cambios de base de datos que se aplican solos (el cron de cada minuto los revisa; solo corren una vez).
let done = false;
const DOC_ALLOWED = `create or replace function public.doc_allowed(p text, op text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare seg text[] := string_to_array(p, '/'); lvl int := user_level(); me text := auth.uid()::text; need int;
begin
  if lvl = 0 then return false; end if;
  -- Influencer Outreach (Mich): ve y actualiza la Lista de influencers de todo el equipo
  if seg[1] = 'meets' and seg[3] = 'vip' and exists (select 1 from docs d where d.path = 'roles/' || me and d.data->>'role' = 'influencer') then
    return lvl >= 2;
  end if;
  -- Influencer Outreach y quien tiene "Puede ver Resultados": consulta (solo lectura) los prospectos y tareas del equipo (team-ro-v1, results-v1)
  if seg[1] = 'meets' and op = 'read' and exists (select 1 from docs d where d.path = 'roles/' || me and (d.data->>'role' = 'influencer' or (d.data->>'canResults')::boolean is true)) then
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
      when 'taskRules'     then case when exists (select 1 from docs d where d.path = 'roles/' || me and d.data->>'role' = 'influencer') then 2 else 3 end -- la Influencer crea tareas recurrentes (rules-infl-v1)
      when 'emailTpl'      then case when op = 'read' then 2 else 3 end -- plantillas de email automático (email-v1)
      when 'waTemplates'   then case when op = 'read' then 2 else 3 end
      when 'config'        then case when op = 'read' then 1 else 4 end
      when 'weeks'         then case when op = 'read' then 1 else 4 end -- resultados congelados al cierre de cada semana (weeks-v1)
      else 4 end;
  end if;
  return lvl >= need;
end $$;`;
async function migrate(c){
  if (done) return;
  const src = (await c.query("select prosrc from pg_proc where proname='doc_allowed' limit 1")).rows[0];
  if (src && !/weeks-v1/.test(src.prosrc)) await c.query(DOC_ALLOWED);
  // archivos de tareas y comentarios: todo el equipo puede subir (antes solo Head/Manager) y se aceptan PDF y fotos sin restricción de tipo (files-v2)
  try{
    const pol = (await c.query("select with_check from pg_policies where schemaname='storage' and tablename='objects' and policyname='assets_upload'")).rows[0];
    if (!pol || !/>=\s*2/.test(pol.with_check || ""))
      await c.query("drop policy if exists assets_upload on storage.objects; create policy assets_upload on storage.objects for insert to authenticated with check (bucket_id = 'assets' and public.user_level() >= 2);");
  }catch(_){}
  try{ await c.query("update storage.buckets set allowed_mime_types = null, public = true where id = 'assets' and (allowed_mime_types is not null or public is not true)"); }catch(_){}
  done = true;
}
module.exports = {migrate};
