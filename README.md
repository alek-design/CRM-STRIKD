# CRM STRIKD — Growth

Tablero de outreach de STRIKD: registro de meets, journey del pitch a publicado, leaderboard, embudo, Lista Mich, canal de WhatsApp, mensajes y plantillas A/B.

## Estado actual

`index.html` es la versión que hoy corre como artifact en claude.ai. Depende del runtime de claude.ai (`window.claude.use(...)`) para:

- **Login y roles** (`user`): Head, Creator Partnerships Manager, Account Manager
- **Base de datos** (`db`): meets, validaciones, puntos, roles, Lista Mich, WhatsApp, plantillas
- **Archivos** (`assets`): skeletons y PDFs de plantillas
- **Google Calendar** (`mcp`) e **IA para sugerir respuestas** (`sample`)

Fuera de claude.ai (por ejemplo en growth.strikd.ai) la página carga pero muestra "Abre esta página con tu sesión de claude.ai", porque esas piezas no existen ahí.

## Para que funcione en growth.strikd.ai

Reemplazar la capa `claude.use(...)` por un backend propio:

1. **Supabase**: Auth (invitaciones por correo y roles), Postgres con RLS y Storage.
2. **Funciones de servidor** (Vercel u otro): Google Calendar con OAuth de STRIKD e integración con ISKRA (`ISKRA_API_KEY` como variable de entorno, nunca en el código).
3. Migrar los datos actuales del artifact a Postgres.

Nunca subas llaves ni `.env` a este repositorio.
