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
  // tareas abiertas que vencían a las 6:00 pm (Cancún): pasan a las 11:59 pm del mismo día (due-2359). Idempotente
  try{
    await c.query(`update public.docs set data = (data || jsonb_build_object('dueAt', (data->>'dueAt')::bigint + 21540000))
        - (case when (data->>'dueAt')::bigint + 21540000 > $1 then array['lateAt','dueSoonAt'] else array[]::text[] end),
      version = version + 1, updated_at = now()
      where path like 'meets/%/tasks/%' and coalesce(data->>'status','todo') <> 'done' and (data->>'dueAt') ~ '^[0-9]+$'
        and (data->>'dueAt')::bigint > 0 and (((data->>'dueAt')::bigint - 18000000) % 86400000) = 64800000`, [Date.now()]);
  }catch(_){}
  // plantillas "Después de 24 h" que Alek armó en ISKRA (Copy Studio, carpeta 24hr window). La API no da las copies: se dan de alta aquí con el mismo texto
  // y el nombre del molde aprobado; el panel busca su id por nombre (h24-v1). Una sola vez: si ya existen no se tocan
  try{
    const now = Date.now(), v = (text, mold) => ({text, fileId:"", fileName:"", iskTplId:"", iskTplName:mold});
    const T = [
      ["waTemplates/h24_retomar", {name:"Retomar después de 24 h", trigger:"h24", active:true, autoSend:false, createdAt:now, updatedAt:now, variants:{
        a:v("Queríamos retomar nuestra conversación y saber si tuviste oportunidad de revisar lo que te compartimos.", "4c138_es_h1_6de8f"),
        b:v("Me gustaría conocer tu opinión sobre lo que te platicaba. ¿Cómo lo ves?", "4c138_es_h1_6de8f"),
        c:v("No sé si viste mi último mensaje. ¿Crees que sea algo que te pueda interesar?", "4c138_es_h1_6de8f")}}],
      ["waTemplates/h24_seguimiento", {name:"Doy seguimiento a mi último mensaje", trigger:"h24", active:true, autoSend:false, createdAt:now, updatedAt:now, variants:{
        a:v("Quería saber si tuviste oportunidad de revisarlo.", "af679_r2_es_n1"), b:v("", ""), c:v("", "")}}]];
    for (const [path, data] of T) await c.query("insert into public.docs (path, data) values ($1,$2) on conflict (path) do nothing", [path, data]);
    // las copies ya están habilitadas como "24h reply" en ISKRA (salen por nombre en la API): conectar cada variante con su copy (h24-v2), solo si no la eligieron a mano
    // (h24-v3) la API solo da los moldes por código, no las copies: cada variante va con el código de su molde
    const COPY = {"waTemplates/h24_retomar":{a:"4c138_es_h1_6de8f", b:"4c138_es_h1_6de8f", c:"4c138_es_h1_6de8f"}, "waTemplates/h24_seguimiento":{a:"af679_r2_es_n1"}};
    // (h24-v4) ISKRA manda las plantillas con el id de la copy marcada "24h reply" (template_group_id), no con el del molde.
    // "Después de la ventana de 24hrs" (molde 4c138, {{1}} = texto) → sirve para las 3 variantes de "Retomar"
    // (h24-v5) "Doy seguimiento…" (molde af679) con su copy c7bb92a0
    await c.query(`update public.docs set data = jsonb_set(jsonb_set(data, '{variants,a,iskTplId}', to_jsonb('c7bb92a0-8175-45ec-a9c5-3b108b1d0c04'::text)), '{variants,a,iskTplName}', to_jsonb('Después de ventana 24hrs'::text)),
        version = version + 1, updated_at = now() where path = 'waTemplates/h24_seguimiento' and coalesce(data#>>'{variants,a,iskTplId}', '') <> 'c7bb92a0-8175-45ec-a9c5-3b108b1d0c04'`);
    const GRP = "ec427d7e-0dac-4b3a-a7ab-9c66f3a45dc6";
    for (const k of ["a","b","c"]) await c.query(`update public.docs set data = jsonb_set(jsonb_set(data, $1::text[], to_jsonb($2::text)), $3::text[], to_jsonb('Después de la ventana de 24hrs'::text)),
        version = version + 1, updated_at = now() where path = 'waTemplates/h24_retomar' and coalesce(data#>>$1::text[], '') <> $2`, [`{variants,${k},iskTplId}`, GRP, `{variants,${k},iskTplName}`]);
    for (const [path, map] of Object.entries(COPY)) for (const [k, name] of Object.entries(map))
      await c.query(`update public.docs set data = jsonb_set(data, $2::text[], to_jsonb($3::text)), version = version + 1, updated_at = now()
        where path = $1 and coalesce(data#>>$4::text[], '') = '' and coalesce(data#>>$2::text[], '') <> $3`, [path, `{variants,${k},iskTplName}`, name, `{variants,${k},iskTplId}`]);
  }catch(_){}
  done = true;
}
module.exports = {migrate};
