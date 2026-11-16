# DIS-01 + OBS-01 · Caída de réplicas bajo carga (QA, 16 nov 2026)

## Cómo se probó

- `dis01/caos-bajo-carga.mjs`: 60 compradores conectados por WebSocket, 5 pujas/s, sonda REST cada 200 ms a `/api/subastas/{id}`.
- A los 30 s se detiene el proceso (PID 1, `kill -TERM 1` por `az containerapp exec`) de **1 réplica de auction-service y 1 de realtime-gateway**. Se observa 90 s más.
- Azure Container Apps reinicia el contenedor dentro de la misma réplica (restartCount + 1); el script ya acepta eso como reposición.
- Después del cierre de la subasta, `dis01/verificar-cierre.sh <subasta>` revisa en solo lectura: estado, eventos `subasta.cerrada` en el outbox y movimientos del wallet.

Nota: el script anterior `scripts/dis-01-caos.sh` no detenía nada (sin terminal para `exec`, comillas en `--command` y `kill -9 1`, que el kernel ignora para PID 1). Se corrigió.

## Resultados

| Corrida | Falla (UTC) | Alerta "Réplica caída" | Cierre y cobro |
|---|---|---|---|
| Subasta 806c1954 | 21:52:12 | Firing 21:52:40 (28 s) | FINALIZADA, 1 cierre, 1 COBRO, 1 ABONO_VENTA ✅ |
| Subasta 2b2b381c | 22:02:29 | Firing 22:03:40 (71 s) | FINALIZADA, 1 cierre, 1 COBRO, 1 ABONO_VENTA ✅ |

Corrida medida completa (2b2b381c):

| Criterio | Meta | Resultado | |
|---|---|---|---|
| Alerta de réplica caída | ≤ 2 min | 28 s y 71 s (la regla evalúa cada 1 min) | ✅ |
| Réplicas repuestas | 2 por servicio | 22:04:24 (≈ 2 min, arranque de la JVM con 0.25 vCPU) | ✅ |
| Exactamente 1 cierre y 1 cobro | 1 y 1 | 1 y 1 | ✅ |
| Errores REST en los 30 s tras la falla | < 2 % | 6 de 33 (18.18 %): 15 tiempos agotados de 5 s y 2 respuestas 502 en toda la corrida | ❌ |
| Reconexión WebSocket | < 10 s | 36 cortados: 18 en ≈ 0.55 s, el resto en 9, 18, 27, 35 y 52 s | ❌ |
| Pujas aceptadas perdidas | 0 | No medible: la lectura final por REST también agotó tiempo (599 pujas enviadas). El cierre y el cobro sí cuadran | ⚠️ |

## Hallazgo y causa

Los reintentos siguen una distribución geométrica con p ≈ 0.5: la mitad de los clientes se reconecta al instante y el resto vuelve a caer en la réplica que se está reiniciando, intento tras intento (cada intento espera 8 s). Es decir, **el ingreso de Container Apps sigue repartiendo ≈ 50 % del tráfico a la réplica caída mientras su contenedor reinicia** (≈ 60 a 110 s), aunque tiene sondas Startup, Liveness y Readiness configuradas (periodo 5 s, umbral 3).

## Mejoras propuestas (no aplicadas)

1. Cliente web: tiempo de espera de conexión WebSocket corto (2 s) y reintento inmediato con un poco de aleatoriedad; con p ≈ 0.5 la reconexión esperada baja a pocos segundos.
2. api-gateway: reintento a otra réplica en GET idempotentes (`Retry` de Spring Cloud Gateway con tiempo de espera corto) para que la sonda REST no vea tiempos agotados.
3. Readiness más agresiva (periodo 2 s, umbral 1) y medir de nuevo si el ingreso la respeta en reinicios dentro de la misma réplica.
4. Más CPU por réplica para acortar el arranque de la JVM.
