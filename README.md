# STRIKD Growth · growth.strikd.ai

Tablero de outreach de STRIKD: registro de meets, journey del pitch a publicado, leaderboard, embudo, Lista Mich, canal de WhatsApp, mensajes y plantillas A/B.

## Cómo está armado

| Archivo | Qué es |
|---|---|
| `src/board.html` | El tablero (la misma pantalla que corría en claude.ai) |
| `claude-shim.js` | Login de STRIKD + conexión a Supabase (base de datos, tiempo real, archivos) |
| `index.html` | Se genera con `./build.sh` a partir de `src/board.html` |
| `api/config.js` | Le pasa al navegador la URL y la llave pública de Supabase |
| `api/invite.js` | El Head invita personas por correo con su rol |
| `api/blob/[id].js` | Sirve skeletons y PDFs (`/_blob/<id>`) |
| `supabase/schema.sql` | Tablas, permisos por rol (RLS), tiempo real y archivos |
| `supabase/seed.sql` | Los datos actuales del tablero (incluye datos de ejemplo) |

## Puesta en marcha (una sola vez)

1. **Base de datos:** en Supabase → *SQL Editor* → pega y corre `supabase/schema.sql`. Luego pega y corre `supabase/seed.sql`.
2. **Tu usuario de Head:** Supabase → *Authentication* → *Users* → *Add user* → *Create new user*, con tu correo y una contraseña, marcando *Auto Confirm User*. El primer usuario que se crea queda como **Head**.
3. **Links de correo:** Supabase → *Authentication* → *URL Configuration*:
   - *Site URL*: `https://growth.strikd.ai`
   - *Redirect URLs*: agrega `https://growth.strikd.ai` y `https://*.vercel.app`
4. **Cerrar registro libre:** Supabase → *Authentication* → *Providers / Sign In* → apaga *Allow new users to sign up*. Así solo entra quien tú invites.
5. **Vercel:** las variables `SUPABASE_URL`, `SUPABASE_ANON_KEY` (o `NEXT_PUBLIC_…`) y `SUPABASE_SERVICE_ROLE_KEY` las pone la integración de Supabase. Redeploy después de conectarla.
6. Entra a growth.strikd.ai con tu correo → *Organigrama* → *Accesos* → invita a tu equipo.

## Roles

- **Head**: ve todo, invita, cambia roles y reglas.
- **Creator Partnerships Manager**: ve a todo el equipo, valida, pitchea y lleva a publicado.
- **Account Manager**: solo sus prospectos; registra meets, confirma y propone influencers.

Los permisos se aplican en la base de datos (RLS), no solo en la pantalla.

## Pendiente (segunda parte)

- Google Calendar con el OAuth de STRIKD (invitaciones con Meet).
- Sugerencias de respuesta con IA (bandeja de Mensajes).
- ISKRA: campañas, conversaciones y envío (`ISKRA_API_KEY` como variable de Vercel).

Nunca subas llaves ni `.env` a este repositorio.
