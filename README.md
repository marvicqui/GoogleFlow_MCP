# GoogleFlow_MCP

Servidor **MCP** para crear videos e imágenes con los modelos de [Google Flow](https://flow.google.com/) (**Veo 3.1** y **Nano Banana**) desde **Claude Code** y **Codex**, con instrucciones en lenguaje natural.

> "Hazme un video vertical de 8 s de una taza de café humeante en una cocina al amanecer, cámara lenta, con sonido de lluvia."

El agente (Claude o Codex) convierte tu petición en un prompt cinematográfico, llama a Veo, espera el render y te deja el `.mp4` en tu disco.

## Cómo funciona

```
Claude Code / Codex  ──MCP (stdio)──▶  googleflow-mcp  ──Gemini API / Vertex AI──▶  Veo 3.1 · Nano Banana
                                              │
                                              └──▶ ./flow-output/{videos,images}/ + manifest.json
```

**Importante:** flow.google.com no tiene una API pública. Este servidor usa la **API oficial de Gemini** (o Vertex AI), que da acceso a los mismos modelos que usa Flow. Consecuencias:

- Los clips **no aparecen en tu proyecto de Flow**; se guardan en local (`FLOW_OUTPUT_DIR`). Puedes subirlos a Flow como "ingredients" si quieres seguir editando allí.
- Se cobra por uso a tu API key de Gemini / proyecto de Google Cloud, **no** con los créditos de tu suscripción de Google AI.
- No hace scraping ni automatiza el navegador, así que no rompe cuando Google cambia la interfaz de Flow ni viola sus términos.

## Herramientas

| Herramienta | Equivale en Flow a | Qué hace |
|---|---|---|
| `flow_generate_video` | Text / Frames / Ingredients to Video | Genera clips con Veo. Admite primer y último fotograma, hasta 3 imágenes de referencia, relación de aspecto, resolución, duración, prompt negativo y semilla. |
| `flow_extend_video` | Extend / Scene Builder | Continúa un clip generado antes con un nuevo prompt. |
| `flow_check_operation` | — | Consulta un render pendiente y lo descarga cuando termina. |
| `flow_generate_image` | Generación de imágenes (Nano Banana) | Crea o edita imágenes (personajes, productos, fotogramas clave) para usarlas después en video. |
| `flow_list_assets` | Biblioteca del proyecto | Lista lo generado, con ids y rutas locales. |
| `flow_list_models` | — | Muestra qué modelos Veo / imagen tiene disponibles tu key. |

También incluye el prompt MCP **`flow_director`**: le das una idea y arma un guion de tomas y las renderiza paso a paso.

Las imágenes generadas reciben un id (`img_…`) que puedes pasar directamente como `startImage`, `endImage` o `referenceImages` para mantener la consistencia de personajes.

## Requisitos

- Node.js 20 o superior
- Una API key de Gemini: <https://aistudio.google.com/apikey> (Veo necesita la facturación activada en el proyecto)
  - Alternativa: Vertex AI con `gcloud auth application-default login`

## Instalación

**PowerShell (Windows)**

```powershell
git clone https://github.com/marvicqui/GoogleFlow_MCP.git C:\src\GoogleFlow_MCP
cd C:\src\GoogleFlow_MCP
npm install      # también compila (script "prepare")
```

**bash (macOS / Linux)**

```bash
git clone https://github.com/marvicqui/GoogleFlow_MCP.git ~/src/GoogleFlow_MCP
cd ~/src/GoogleFlow_MCP
npm install
```

## Conectar con Claude Code

```powershell
# PowerShell
claude mcp add googleflow --scope user `
  -e GEMINI_API_KEY=$env:GEMINI_API_KEY `
  -e FLOW_OUTPUT_DIR="$HOME\Videos\flow" `
  -- node C:\src\GoogleFlow_MCP\dist\index.js
```

```bash
# bash
claude mcp add googleflow --scope user \
  -e GEMINI_API_KEY="$GEMINI_API_KEY" \
  -e FLOW_OUTPUT_DIR="$HOME/Videos/flow" \
  -- node ~/src/GoogleFlow_MCP/dist/index.js
```

Comprueba con `claude mcp list` o `/mcp` dentro de Claude Code. Para compartirlo con un equipo, usa un `.mcp.json` en el repo (ver [`examples/claude-mcp.json`](examples/claude-mcp.json)).

Si un render largo se corta por tiempo, sube el timeout de herramientas MCP antes de abrir Claude Code: `$env:MCP_TOOL_TIMEOUT=600000` (PowerShell) o `export MCP_TOOL_TIMEOUT=600000` (bash). Otra opción es pedir `wait: false` y luego usar `flow_check_operation`.

## Conectar con Codex

```powershell
codex mcp add googleflow --env GEMINI_API_KEY=$env:GEMINI_API_KEY -- node C:\src\GoogleFlow_MCP\dist\index.js
```

Luego, en `~/.codex/config.toml`, sube el timeout (un video tarda de 1 a 6 minutos y Codex corta a los 60 s por defecto):

```toml
[mcp_servers.googleflow]
command = "node"
args = ["C:\\src\\GoogleFlow_MCP\\dist\\index.js"]
tool_timeout_sec = 600

[mcp_servers.googleflow.env]
GEMINI_API_KEY = "tu-api-key"
```

Ejemplo completo en [`examples/codex-config.toml`](examples/codex-config.toml).

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `GEMINI_API_KEY` | — | API key de Gemini (obligatoria si no usas Vertex). También vale `GOOGLE_API_KEY`. |
| `GOOGLE_GENAI_USE_VERTEXAI` | `false` | `true` para usar Vertex AI. |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | — / `us-central1` | Proyecto y región de Vertex AI. |
| `FLOW_OUTPUT_DIR` | `./flow-output` | Carpeta donde se guardan videos, imágenes y `manifest.json`. |
| `FLOW_VIDEO_MODEL` | `veo-3.1-generate-preview` | Modelo de video principal. |
| `FLOW_VIDEO_FAST_MODEL` | `veo-3.1-fast-generate-preview` | Modelo usado con `fast: true` (borradores más baratos). |
| `FLOW_IMAGE_MODEL` | `gemini-3-pro-image-preview` | Modelo de imagen (Nano Banana Pro). También acepta modelos `imagen-*`. |

Google renombra los modelos a menudo (sobre todo los `-preview`). Si uno deja de existir, pide "lista los modelos de Flow disponibles" (`flow_list_models`) y ajusta la variable.

## Ejemplos de instrucciones

- "Genera un video 16:9 de 8 segundos: dron sobrevolando un bosque de niebla al amanecer, estilo documental, con ambiente de pájaros."
- "Crea una imagen de mi personaje: una astronauta de 30 años con traje naranja, estilo Pixar. Luego haz un video donde ella camina por Marte usando esa imagen como referencia."
- "Usa `C:\fotos\producto.png` como primer fotograma y haz un giro de 360° del producto sobre fondo blanco, versión rápida."
- "Extiende el último video: la cámara se aleja y se ve la ciudad."
- "/mcp__googleflow__flow_director un anuncio de 30 segundos para una cafetería, formato 9:16"

## Desarrollo

```bash
npm run dev       # tsc --watch
npm run inspect   # abre MCP Inspector para probar las herramientas
```

Estructura:

```
src/
  index.ts    # definición del servidor MCP, herramientas y prompt
  flow.ts     # cliente de Veo / Nano Banana (SDK @google/genai)
  store.ts    # manifest local de assets y operaciones pendientes
  config.ts   # variables de entorno
```

## Limitaciones

- No lee ni escribe en tus proyectos de flow.google.com (no hay API pública para eso).
- `flow_extend_video` solo funciona con videos generados por este servidor; en la Gemini API el archivo remoto caduca a los ~2 días y la extensión es a 720p.
- Disponibilidad de funciones (4K, audio, imágenes de referencia, último fotograma) depende del modelo y de la región; si la API rechaza un parámetro, el error se devuelve al agente tal cual.
- Con la Gemini API, `generateAudio` y `seed` no existen: el servidor los ignora y lo indica en `ignored`. Veo 3.x genera audio siempre; describe los sonidos en el prompt.
- **Veo no tiene capa gratuita en la Gemini API.** Sin facturación activa verás `429 RESOURCE_EXHAUSTED` aunque no hayas generado nada. Actívala en <https://aistudio.google.com/apikey> ("Set up billing") y revisa el consumo en <https://aistudio.google.com/usage>.
- Los videos de Veo llevan marca de agua SynthID.

## Licencia

MIT
