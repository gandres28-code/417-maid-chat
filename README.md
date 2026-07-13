# 417 Maid Chat

Aplicación separada del 417 Maid OS actual. Esta primera versión incluye:

- Login independiente por código y contraseña
- PostgreSQL
- Conversaciones y grupos
- Mensajes en tiempo real con Socket.IO
- Presencia y eventos de escritura preparados
- Subidas directas a almacenamiento S3-compatible mediante URL firmada
- Endpoint de tokens para llamadas LiveKit
- Interpretación de mensajes con IA y bandeja `ai_actions`
- Sin cambios en el servidor principal de 417 Maid OS

## Arranque local

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:init
npm run dev
```

Abre `http://localhost:4100`.

Login de demostración:

```text
Código: 0001
Contraseña: 1234
```

## MinIO local

Consola: `http://localhost:9001`

```text
Usuario: minioadmin
Contraseña: minioadmin
```

Crea un bucket llamado `maid-chat` y permite lectura pública solo para desarrollo. En producción usa Cloudflare R2 y URLs firmadas.

## Variables de producción

Configura PostgreSQL administrado, Cloudflare R2, LiveKit y OpenAI usando `.env.example`.

## Siguiente etapa

1. Panel administrativo de acciones de IA
2. Chats directos y creación de grupos
3. Fotos, video, audio y documentos desde la interfaz
4. Reacciones, respuestas, entregado y leído
5. Llamadas y videollamadas dentro de la interfaz
6. Notificaciones push
7. Pruebas de carga y despliegue horizontal
8. Integración posterior con 417 Maid OS y HotSOS
