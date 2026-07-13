# 417 Maid Chat v1

Aplicación independiente de chat en tiempo real para GitHub + Render.

## Incluido

- Login por código y PIN
- PostgreSQL
- Conversaciones y grupos
- Mensajes Socket.IO en tiempo real
- Presencia e indicador de escritura
- Historial paginado
- Fotos, videos, audios y archivos mediante Cloudinary
- Interpretación estructurada por IA
- Bandeja API de acciones para administradores
- Base separada de 417 Maid OS

## Subir a GitHub

Sube **todo el contenido de esta carpeta** a la raíz del repositorio `417-maid-chat`.
`server.js` y `package.json` deben quedar en la raíz.

## Render

1. Crea una base de datos PostgreSQL en Render.
2. Crea un Web Service conectado al repositorio `417-maid-chat`.
3. Build Command:

```bash
npm install && npm run db:init
```

4. Start Command:

```bash
npm start
```

5. Variables mínimas:

```text
DATABASE_URL=<Internal Database URL de Render PostgreSQL>
DATABASE_SSL=false
JWT_SECRET=<cadena aleatoria larga>
ADMIN_NAME=Andres
ADMIN_CODE=0001
ADMIN_PIN=1234
```

6. Variables opcionales para archivos:

```text
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

7. Variables opcionales para IA:

```text
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
```

## Prueba

Abre la URL de Render e inicia sesión con el código y PIN configurados.

## Importante

Esta primera versión deja la app principal intacta. Las llamadas de voz/video se conectarán después con LiveKit. Para soportar miles de usuarios concurrentes se añadirá Redis y escalado horizontal después de validar este flujo base.
