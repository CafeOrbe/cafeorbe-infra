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

## Mejoras propuestas

1. Cliente web: tiempo de espera de conexión WebSocket corto (2 s) y reintento inmediato con un poco de aleatoriedad; con p ≈ 0.5 la reconexión esperada baja a pocos segundos.
2. api-gateway: reintento a otra réplica en GET idempotentes (`Retry` de Spring Cloud Gateway con tiempo de espera corto) para que la sonda REST no vea tiempos agotados.
3. Readiness más agresiva (periodo 2 s, umbral 1) y medir de nuevo si el ingreso la respeta en reinicios dentro de la misma réplica.
4. Más CPU por réplica para acortar el arranque de la JVM.

## Estado de las mejoras (16 nov 2026, después de esta corrida)

| Mejora | Estado |
|---|---|
| 1. Cliente web: conexión descartada a 1,5 s, 3 reintentos a 200 ms | Integrada (cafeorbe-web#6) |
| 2. api-gateway: GET con límite de 1200 ms y 4 reintentos ante 502/503/504 | Integrada (cafeorbe-api-gateway#9) |
| 3. Readiness cada 2 s, 2 fallos | Integrada (#9). Se aplica con el workflow "DIS-01 · disponibilidad en Azure" |
| 4. Más CPU por réplica | Pendiente: solo si la nueva corrida no cumple |

Ajustes a `caos-bajo-carga.mjs` para la nueva corrida:

- Los compradores simulados se reconectan con la misma política que el cliente web (antes esperaban 8 s por intento), así que el tiempo medido es el que vería un comprador real.
- La sonda REST espera hasta 10 s (antes 5 s) para que el resultado refleje la respuesta del gateway con sus reintentos; la latencia p95 y máxima de los 30 s tras la falla se reporta aparte.
- La lectura final de pujas se reintenta hasta 6 veces, para que "0 pujas perdidas" no quede sin medir.
- Además de las pujas guardadas sin aviso ("perdidas"), se cuentan las avisadas como aceptadas que no quedaron guardadas ("fantasma"); el criterio exige 0 de ambas. Las pujas enviadas sin ninguna respuesta se reportan solo como dato.

## Corrida con las mejoras 1–3 (subasta d265528b, falla 23:31:16 UTC)

Antes de la corrida se ejecutó el workflow "DIS-01 · disponibilidad en Azure" (run 43979267313): aplicó 2–4 réplicas y las tres sondas en los tres servicios. Su paso de verificación falló porque consultó la readiness mientras auction y realtime reiniciaban; minutos después los tres respondían `{"status":"UP"}`.

| Criterio | Meta | Resultado | |
|---|---|---|---|
| Errores REST en los 30 s tras la falla | < 2 % | 0 de 61 (0 %); p95 1414 ms; en toda la corrida 210 respuestas 200 y 1 504 | ✅ |
| Pujas aceptadas perdidas / fantasma | 0 | 0 / 0 (599 enviadas, 155 aceptadas, 164 sin respuesta) | ✅ |
| Réplicas repuestas | 2 por servicio | 23:33:05 (≈ 1 min 50 s) | ✅ |
| Exactamente 1 cierre y 1 cobro | 1 y 1 | FINALIZADA, 1 evento de cierre, 1 COBRO, 1 ABONO_VENTA | ✅ |
| Reconexión WebSocket | < 10 s | 27 cortados (todos con 1006): 26 en menos de 7 s; 1 en 16,6 s | ❌ |

Distribución de las 27 reconexiones: 14 en ≈ 0,4 s, 6 en ≈ 2,1 s, 3 en ≈ 3,8 s, 3 en ≈ 6,6 s y 1 en 16,6 s. Cada escalón de ≈ 1,7 s es un intento que quedó colgado hasta el límite de 1,5 s más la espera de 200 ms: la mitad de los intentos sigue cayendo en la réplica que reinicia. El de 16,6 s tuvo 5 intentos fallidos seguidos y, con la espera duplicándose desde el 4.º, esperó 4 s antes del intento bueno.

### Mejora 5: ventana rápida de 10 s y límite de conexión adaptativo

En `cafeorbe-web` (`salaSocket.ts`) y en `caos-bajo-carga.mjs`, con la misma política:

- Durante los primeros 10 s tras el corte se reintenta cada 200 ms (+ hasta 30 % aleatorio), sin duplicar la espera. Pasada la ventana: 1 s, 2 s, 4 s, 8 s y 10 s.
- El límite para abrir es 3 veces lo que tardó la última conexión buena, entre 0,8 y 3 s (1,5 s antes de la primera). Cerca del servidor un intento colgado cuesta ≈ 1 s; con una red lenta el límite sube y la conexión no se descarta antes de poder abrir.

Simulación con la mitad de los intentos colgados y apertura en ≈ 0,2 s (lo medido en Cloud Shell), 200 000 reconexiones por política:

| Política | p50 | p99 | Comprador con 10 s o más | Alguno de 27 con 10 s o más |
|---|---|---|---|---|
| Anterior (límite 1,5 s, 3 reintentos rápidos) | 2,1 s | 27,8 s | 6,13 % | 81,9 % |
| Mejora 5 (ventana de 10 s, límite 0,8 s) | 0,5 s | 6,6 s | 0,09 % | 2,4 % |

Para cerrar DIS-01: integrar los dos cambios, esperar el despliegue de web y repetir la corrida de caos (`preparar-ren01.mjs`, `caos-bajo-carga.mjs` y `verificar-cierre.sh`).

## Corridas del 17 nov con la mejora 5

**Subasta 5e43078f, falla 00:08:11 UTC (auction y realtime).** REST 0 % de errores en 30 s (69 consultas, p95 618 ms), 0 pujas perdidas y 0 fantasma (152 aceptadas), réplicas repuestas a las 00:09:59 y `verificar-cierre.sh`: FINALIZADA, 1 cierre, 1 COBRO, 1 ABONO_VENTA. Reconexión: 24 de 25 en menos de 7 s (15 en ≈ 0,37 s, 8 en ≈ 3,5 s) y **1 en 10,06 s** ❌. El tablero técnico marcó la caída a los ≈ 22 s del último envío (infra #13).

**Falla 00:47:42 UTC (solo realtime: el `exec` en auction devolvió InternalServerError de Azure).** Con el registro de intentos (infra #14): los 39 intentos fallidos fueron de **conexión** ("no abrió a tiempo"), ninguno del ticket. Los dos clientes más lentos (10,06 y 9,72 s) tenían el límite para abrir en 3000 y 2883 ms porque su primera conexión fue lenta (los 60 entran a la vez al empezar): cada intento colgado en la réplica caída les costó ≈ 3 s, y tres seguidos ya suman 9–10 s. REST 0 % (91 consultas, p95 181 ms); 0 pujas perdidas, 0 fantasma y 0 sin respuesta.

### Mejora 6: tope de 1,5 s para el límite dentro de la ventana rápida

En `cafeorbe-web` (`salaSocket.ts`) y en `caos-bajo-carga.mjs`: durante los primeros 10 s tras el corte, el límite para abrir es el adaptativo pero **nunca más de 1,5 s**; pasada la ventana vuelve a valer completo (hasta 3 s), para que una red de verdad lenta termine conectando. Cada intento colgado cuesta ≤ 1,7 s dentro de la ventana y caben al menos 5 en 10 s; con el límite de 3 s del 17 nov, tres intentos colgados pasan de ≈ 10 s a menos de 6 s (prueba automática en `salaSocket.test.ts`).
