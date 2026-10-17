# STRIKD Growth · growth.strikd.ai

Tablero de outreach de STRIKD: registro de meets, journey del pitch a publicado, leaderboard, embudo, Lista Mich, canal de WhatsApp, mensajes y plantillas A/B.

## Cómo está armado

| Archivo | Qué es |
|---|---|
| `src/board.html` | El tablero (la misma pantalla que corría en claude.ai) |
| `claude-shim.js` | Login de STRIKD + conexión a Supabase (base de datos, tiempo real, archivos) |
| `index.html` | Se genera con `./build.sh` a partir de `src/board.html` |
| `api/config.js` | Le pasa al navegador la URL y la llave pública de Supabase |
| `api/invite.js` | El Head da de alta personas con su rol |
| `api/setup.js` | Configuración inicial (tablas, datos y cuenta del Head) |
| `api/google/*`, `lib/google.js` | Conexión de cada persona con su Google Calendar |
| `api/blob/[id].js` | Sirve skeletons y PDFs (`/_blob/<id>`) |
| `supabase/schema.sql` | Tablas, permisos por rol (RLS), tiempo real y archivos |
| `supabase/seed.sql` | Los datos actuales del tablero (incluye datos de ejemplo) |

## Puesta en marcha

Ya no hay que tocar Supabase a mano:

1. Abre growth.strikd.ai. La primera vez sale **"Configurar STRIKD Growth"**: pon tu nombre, correo y contraseña. Eso crea las tablas, carga los datos y te deja como **Head**.
2. Entra → *Organigrama* → *Accesos* → da de alta a tu equipo. A cada persona se le crea una contraseña temporal que le mandas tú; al entrar la cambia con "Cambiar contraseña".

Necesita estas variables en Vercel (la integración de Supabase las pone sola): `SUPABASE_URL`, `SUPABASE_ANON_KEY` (o `NEXT_PUBLIC_…`), `SUPABASE_SERVICE_ROLE_KEY`, `POSTGRES_URL`.

Opcional, para que funcione "Olvidé mi contraseña": Supabase → *Authentication* → *URL Configuration* → *Site URL* = `https://growth.strikd.ai`.

## Roles

- **Head**: ve todo, invita, cambia roles y reglas.
- **Creator Partnerships Manager**: ve a todo el equipo, valida, pitchea y lleva a publicado.
- **Account Manager**: solo sus prospectos; registra meets, confirma y propone influencers.

Los permisos se aplican en la base de datos (RLS), no solo en la pantalla.

## Google Calendar

Cada persona toca **Conectar mi Google Calendar** (arriba) y da permiso. Desde ahí sus meets crean invitación con link de Meet, se borran al cancelar y se detecta si el prospecto la rechaza.

Configuración (una vez): proyecto de Google Cloud con **Google Calendar API** habilitada, pantalla de consentimiento y un **ID de cliente OAuth (Aplicación web)** con redirect `https://growth.strikd.ai/api/google/callback`. En Vercel: `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`. Los permisos de cada quien se guardan en la tabla `google_tokens` (solo el servidor la lee).

## Pendiente

- Sugerencias de respuesta con IA (bandeja de Mensajes).
- ISKRA (hecho, primera parte): Mensajes → "ISKRA en vivo" lee conversaciones y contesta desde el número de STRIKD (`ISKRA_API_KEY` en Vercel; solo Head y Manager). Falta: enviar plantilla para iniciar, webhook de respuestas, campañas.

Nunca subas llaves ni `.env` a este repositorio.
