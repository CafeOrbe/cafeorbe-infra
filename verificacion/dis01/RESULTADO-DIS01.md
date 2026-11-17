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

## Mejora 4: 1 vCPU / 2 GiB

Prueba del **17 nov 2026 (UTC)**, desde Azure Cloud Shell (Bash), sobre QA (`cafeorbe-org`, ambiente express `cafeorbe-qa`, East US 2). Código de infra: `3695513` (incluye el tope de reconexión de la mejora 6). Se ejecutaron tres corridas consecutivas con `node preparar-ren01.mjs --compradores 60 --minutos 10` y `node caos-bajo-carga.mjs`, con sus valores predeterminados: 5 pujas/s, 30 s antes de la falla y 90 s después. En las tres se conectaron 60/60 compradores y se confirmó el reinicio de una réplica de cada servicio; no hubo que descartar intentos por el error intermitente de `exec`.

Único ajuste de infraestructura para esta prueba: `bash scripts/ren-01-carga.sh preparar`. Ambas apps pasaron de **0,25 vCPU / 0,5 GiB, mínimo 2 y máximo 4 réplicas**, a **1 vCPU / 2 GiB y exactamente 2 réplicas**. Las dos confirmaron readiness UP antes de iniciar la carga. No se modificó código de servicios ni la política de reconexión de la web o del generador de carga. Los secretos se resolvieron dentro de Cloud Shell y no se incluyeron en la evidencia.

La configuración anterior y la aplicada están en [`mejora4/`](mejora4/): `antes-{app}.json` y `despues-{app}.json`. **Por la última instrucción del operador, al terminar se mantiene 1 vCPU / 2 GiB y 2 réplicas fijas en ambas apps; no se ejecutó `restaurar`.** La configuración anterior también quedó guardada por el script en `~/.cafeorbe-ren01-estado` de esta sesión de Cloud Shell.

### Cómo interpretar la reposición

La línea `Reposición` del script es una comprobación tardía: se consulta después de los 90 s posteriores a la falla y de la lectura final de pujas, más varias consultas de Azure CLI. No mide el instante en que la JVM volvió a estar lista. Se conserva sin alteraciones, pero se complementa con un sondeo de réplicas en paralelo, usando `az containerapp replica list` para cada app, con 5 s de espera entre consultas (intervalo efectivo aproximado de 8–10 s, incluido Azure CLI). Los archivos `replicas-{corrida}-{app}.ndjson` guardan las horas UTC de solicitud y respuesta, `ready`, `restartCount`, estado y hora de arranque de cada contenedor.

Para considerar repuesta una víctima se exige reinicio confirmado (contador aumentado o réplica reemplazada) y las dos réplicas de su servicio con `ready=true`. La primera respuesta positiva da una **cota superior observada**, no una duración exacta ni una medición directa del ingreso. Las horas de falla son las de lanzamiento del `exec`, tal como las registra el script.

### Corrida 1: `ec738793-5c7e-4e42-bd8d-d3041601fe8c`

| Medición | Resultado |
|---|---|
| Falla (UTC) | 2026-11-17T02:12:39.912Z |
| Reposición, línea del script (UTC) | 02:14:33.840; +113.9 s |
| Auction: primera observación de reinicio y 2 réplicas listas | 02:13:31.763 UTC; **+51.9 s** (muestra previa aún sin cumplir: +42.7 s) |
| Realtime: primera observación de reinicio y 2 réplicas listas | 02:13:23.496 UTC; **+43.6 s** (muestra previa aún sin cumplir: +34.9 s) |
| WebSocket | 21 cortes; reconexión máxima **6.123 s** |
| REST, 30 s tras la falla | **1.67 %**, 1/60 consultas con error; p95 **744 ms**, máxima 1548 ms |
| Pujas | 599 enviadas; 176 aceptadas; **0 perdidas y 0 fantasma**; 61 enviadas sin respuesta (dato informativo del script) |
| Cierre y cobro | **FINALIZADA; 1 evento de cierre, 1 COBRO y 1 ABONO_VENTA; `cumple: true`** |

| Criterio del script | Resultado |
|---|---|
| Errores REST en los 30 s tras la falla < 2 % | ✅ |
| Reconexión WebSocket < 10 s | ✅ |
| 0 pujas aceptadas perdidas | ✅ |
| Réplicas repuestas (2 por servicio, sin la caída) | ✅ |

Línea de intentos fallidos y todas las reconexiones de 5 s o más:

```text
Intentos fallidos: 37 · {"conexion · no abrió en 1500 ms":30,"conexion · no abrió en 930 ms":2,"conexion · no abrió en 906 ms":1,"conexion · no abrió en 933 ms":1,"conexion · no abrió en 1002 ms":1,"conexion · no abrió en 927 ms":1,"conexion · no abrió en 1023 ms":1}
  6123 ms (corte 02:12:49.753): 49.990 conexion/no abrió en 1500 ms (1868 ms) → 52.062 conexion/no abrió en 1500 ms (1586 ms) → 53.862 conexion/no abrió en 1500 ms (1593 ms)
```

Salida de `bash verificar-cierre.sh ec738793-5c7e-4e42-bd8d-d3041601fe8c` (se conserva la salida completa en el log enlazado):

```json
{"subasta": "ec738793-5c7e-4e42-bd8d-d3041601fe8c", "estado": "FINALIZADA", "conGanador": true, "eventosDeCierre": 1, "movimientosWallet": {"ABONO_VENTA": 1, "COBRO": 1}, "cumple": true}
```

Evidencia: [resultado completo](resultado-caos-2026-11-17T021209912Z.json), [log del caos](mejora4/caos-1.log), [salida del verificador](mejora4/cierre-1.log), [réplicas de auction](mejora4/replicas-1-auction-service.ndjson) y [réplicas de realtime](mejora4/replicas-1-realtime-gateway.ndjson).

### Corrida 2: `15008462-df69-4360-9e67-252355577ea9`

| Medición | Resultado |
|---|---|
| Falla (UTC) | 2026-11-17T02:23:20.894Z |
| Reposición, línea del script (UTC) | 02:25:12.891; +112.0 s |
| Auction: primera observación de reinicio y 2 réplicas listas | 02:24:06.193 UTC; **+45.3 s** (muestra previa aún sin cumplir: +36.9 s) |
| Realtime: primera observación de reinicio y 2 réplicas listas | 02:23:56.815 UTC; **+35.9 s** (muestra previa aún sin cumplir: +27.9 s) |
| WebSocket | 31 cortes; reconexión máxima **6.402 s** |
| REST, 30 s tras la falla | **0 %**, 0/64 consultas con error; p95 **629 ms**, máxima 1510 ms |
| Pujas | 599 enviadas; 169 aceptadas; **0 perdidas y 0 fantasma**; 52 enviadas sin respuesta (dato informativo del script) |
| Cierre y cobro | **FINALIZADA; 1 evento de cierre, 1 COBRO y 1 ABONO_VENTA; `cumple: true`** |

| Criterio del script | Resultado |
|---|---|
| Errores REST en los 30 s tras la falla < 2 % | ✅ |
| Reconexión WebSocket < 10 s | ✅ |
| 0 pujas aceptadas perdidas | ✅ |
| Réplicas repuestas (2 por servicio, sin la caída) | ✅ |

Línea de intentos fallidos y todas las reconexiones de 5 s o más:

```text
Intentos fallidos: 22 · {"conexion · no abrió en 1500 ms":22}
  6402 ms (corte 02:23:29.095): 29.306 conexion/no abrió en 1500 ms (1998 ms) → 31.516 conexion/no abrió en 1500 ms (1582 ms) → 33.345 conexion/no abrió en 1500 ms (1584 ms)
  6290 ms (corte 02:23:29.097): 29.341 conexion/no abrió en 1500 ms (2053 ms) → 31.609 conexion/no abrió en 1500 ms (1583 ms) → 33.398 conexion/no abrió en 1500 ms (1583 ms)
```

Salida de `bash verificar-cierre.sh 15008462-df69-4360-9e67-252355577ea9` (se conserva la salida completa en el log enlazado):

```json
{"subasta": "15008462-df69-4360-9e67-252355577ea9", "estado": "FINALIZADA", "conGanador": true, "eventosDeCierre": 1, "movimientosWallet": {"ABONO_VENTA": 1, "COBRO": 1}, "cumple": true}
```

Evidencia: [resultado completo](resultado-caos-2026-11-17T022250894Z.json), [log del caos](mejora4/caos-2.log), [salida del verificador](mejora4/cierre-2.log), [réplicas de auction](mejora4/replicas-2-auction-service.ndjson) y [réplicas de realtime](mejora4/replicas-2-realtime-gateway.ndjson).

### Corrida 3: `3e6ba9b6-5e7a-42b3-8dac-9bb51fa90799`

| Medición | Resultado |
|---|---|
| Falla (UTC) | 2026-11-17T02:34:00.337Z |
| Reposición, línea del script (UTC) | 02:35:53.963; +113.6 s |
| Auction: primera observación de reinicio y 2 réplicas listas | 02:34:46.212 UTC; **+45.9 s** (muestra previa aún sin cumplir: +36.7 s) |
| Realtime: primera observación de reinicio y 2 réplicas listas | 02:34:46.294 UTC; **+46.0 s** (muestra previa aún sin cumplir: +36.9 s) |
| WebSocket | 24 cortes; reconexión máxima **12.458 s** |
| REST, 30 s tras la falla | **4.35 %**, 2/46 consultas con error; p95 **1518 ms**, máxima 5177 ms |
| Pujas | 599 enviadas; 164 aceptadas; **0 perdidas y 0 fantasma**; 66 enviadas sin respuesta (dato informativo del script) |
| Cierre y cobro | **FINALIZADA; 1 evento de cierre, 1 COBRO y 1 ABONO_VENTA; `cumple: true`** |

| Criterio del script | Resultado |
|---|---|
| Errores REST en los 30 s tras la falla < 2 % | ❌ |
| Reconexión WebSocket < 10 s | ❌ |
| 0 pujas aceptadas perdidas | ✅ |
| Réplicas repuestas (2 por servicio, sin la caída) | ✅ |

Línea de intentos fallidos y todas las reconexiones de 5 s o más:

```text
Intentos fallidos: 25 · {"conexion · no abrió en 1500 ms":25}
  12458 ms (corte 02:34:09.756): 09.992 conexion/no abrió en 1500 ms (1768 ms) → 11.972 conexion/no abrió en 1500 ms (1588 ms) → 13.798 conexion/no abrió en 1500 ms (1583 ms) → 15.594 conexion/no abrió en 1500 ms (1585 ms) → 17.403 conexion/no abrió en 1500 ms (1603 ms) → 19.211 conexion/no abrió en 1500 ms (1592 ms)
  8041 ms (corte 02:34:09.776): 10.030 conexion/no abrió en 1500 ms (1777 ms) → 12.007 conexion/no abrió en 1500 ms (1581 ms) → 13.847 conexion/no abrió en 1500 ms (1586 ms) → 15.659 conexion/no abrió en 1500 ms (1596 ms)
```

Salida de `bash verificar-cierre.sh 3e6ba9b6-5e7a-42b3-8dac-9bb51fa90799` (se conserva la salida completa en el log enlazado):

```json
{"subasta": "3e6ba9b6-5e7a-42b3-8dac-9bb51fa90799", "estado": "FINALIZADA", "conGanador": true, "eventosDeCierre": 1, "movimientosWallet": {"ABONO_VENTA": 1, "COBRO": 1}, "cumple": true}
```

Evidencia: [resultado completo](resultado-caos-2026-11-17T023330337Z.json), [log del caos](mejora4/caos-3.log), [salida del verificador](mejora4/cierre-3.log), [réplicas de auction](mejora4/replicas-3-auction-service.ndjson) y [réplicas de realtime](mejora4/replicas-3-realtime-gateway.ndjson).

### Conclusión

**La mejora 4 no permite cerrar DIS-01 de forma consistente: dos de tres corridas cumplen los cuatro criterios; la tercera falla REST y reconexión.** Las reconexiones máximas fueron de 6,123 s, 6,402 s y **12,458 s**. Los errores REST fueron **1,67 %, 0 % y 4,35 %** (p95: 744, 629 y 1518 ms). En la tercera corrida, un comprador acumuló seis intentos fallidos de conexión antes de reconectar; los 25 intentos fallidos reportados fueron de conexión, ninguno del ticket. No hubo pujas aceptadas perdidas ni fantasma, y cada subasta tuvo exactamente un cierre, un COBRO y un ABONO_VENTA.

Con 1 vCPU, auction volvió a observarse lista entre **45.3 y 51.9 s** después de la falla, y realtime entre **35.9 y 46.0 s**. Frente al arranque histórico de aproximadamente 100–110 s con 0,25 vCPU, la ventana de contenedor reiniciando se acorta. Los registros son compatibles con una ventana menor de tráfico dirigido a la réplica que aún no está lista; no prueban por sí solos que el ingreso haya dejado de enviarle tráfico.

La comparación es contra las corridas históricas descritas arriba y la referencia de las 01:25 aportada para esta prueba (51,2 s de reconexión y 4,26 % REST); no se ejecutó un nuevo control con 0,25 vCPU. Esta prueba utiliza la política de reconexión de la mejora 6 ya presente en `3695513`, por lo que la diferencia de WebSocket frente a corridas con otra política no puede atribuirse exclusivamente a la CPU. La primera corrida quedó cerca del umbral REST (1,67 %) y la tercera incumplió ambos umbrales. Reducir el arranque no elimina los intentos colgados mientras el ingreso sigue enviando tráfico: el aumento de CPU, aun con una recuperación más rápida, resulta insuficiente en estas tres pruebas.

**Estado final:** ambas apps permanecen en 1 vCPU / 2 GiB, mínimo y máximo 2 réplicas, por instrucción explícita del operador. Las comprobaciones finales de recursos y readiness se guardan en `mejora4/final-{app}.json` y `mejora4/readiness-final.json`.
