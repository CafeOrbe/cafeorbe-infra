# Tableros de Grafana (OBS-01)

| Archivo | Tablero | Contenido |
|---|---|---|
| `tablero-negocio.json` | CaféOrbe · Negocio | Pujas aceptadas y rechazadas por minuto y por motivo, conexiones WebSocket (total y por réplica), logins con Google, eventos pendientes en la outbox, subastas creadas, iniciadas y cerradas (con ganador o desiertas) y Orbes gastados |
| `tablero-tecnico.json` | CaféOrbe · Técnico y seguridad | SEG-01 a SEG-03 (login p95, verificación bajo 5 ms, infracciones, bloqueos, rechazos 401/403), REN-01 (p95/p99 de reenvío y registro de pujas, % de 5xx, outbox) y DIS-01 (réplicas activas y reparto por réplica) |

Los dos se refrescan cada 5 s y usan la fuente de datos como variable (`${DS_PROM}`), así que no dependen de
una cuenta en particular.

## Importar

1. En Grafana Cloud: **Dashboards → New → Import**.
2. Subir el JSON y elegir como fuente de datos el Prometheus del stack (`grafanacloud-<stack>-prom`).

## De dónde salen las métricas

Cada réplica de los seis servicios envía sus métricas por OTLP cada 10 s cuando en GitHub están configurados
`OTLP_METRICS_ENABLED=true`, `OTLP_METRICS_URL=<endpoint OTLP>/v1/metrics` (variables) y
`OTLP_METRICS_AUTH=Basic <base64(instancia:token)>` (secreto). Cada serie lleva las etiquetas `application` e
`instancia` (una por réplica).

Al llegar por OTLP, Grafana Cloud nombra las duraciones en milisegundos (`*_milliseconds_bucket`), no en
segundos como `/actuator/prometheus`. Los contadores `cafeorbe_*` aparecen con el primer evento después de cada
despliegue.
