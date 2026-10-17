-- Configuración inicial (sin datos de ejemplo).
insert into public.docs (path, data) values
('config/main', $j${"inviteEmail": "admin@strikd.ai", "updatedAt": 1792120000000}$j$::jsonb)
on conflict (path) do nothing;
