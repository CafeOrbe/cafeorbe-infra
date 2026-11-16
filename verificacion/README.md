# Scripts de verificación

Node.js 22, sin dependencias. Por defecto apuntan al entorno local de este repositorio (`docker compose`); para
QA se pasan `API_URL` y `WS_URL`. CaféOrbe solo admite login con Google, así que las sesiones de prueba las firma
`sesiones-de-prueba.mjs` con `JWT_SECRET` (herramienta del operador; no existe dentro de ningún servicio).

| Script | Qué verifica |
|---|---|
| `seguridad-qa.mjs` | SEG-01, SEG-02 y SEG-03 con sus medidas. Reporte: [`docs/SEGURIDAD.md`](../docs/SEGURIDAD.md) |
| `carga-sala.mjs` | Sala con N compradores. `MODO=sostenida` mide REN-01 (200 compradores, 20 pujas/s, 10 min) |
| `e2e-sprint1.mjs`, `e2e-sprint2.mjs` | Historias de usuario de punta a punta por la API |
| `ui-sprint1.mjs`, `ui-sprint2.mjs`, `ui-publicado.mjs` | Recorridos en el navegador (Chrome por CDP) |
| `sesiones-de-prueba.mjs` | Módulo compartido: firma sesiones y registra a la persona en wallet por el broker |

Variables del broker para `carga-sala.mjs` y los e2e (los Orbes iniciales llegan por evento):
`BROKER_API_URL=https://<host>.lmq.cloudamqp.com`, `BROKER_USER`, `BROKER_PASSWORD`, `BROKER_VHOST` (en CloudAMQP
el vhost es el mismo usuario). Con `SIN_REGISTRO=1` no se publica nada y basta `JWT_SECRET`.

Los scripts crean usuarios y subastas de prueba con un sufijo único que cierran solas: no usarlos contra producción.
