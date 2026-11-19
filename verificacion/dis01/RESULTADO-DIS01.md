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

La configuración anterior y la aplicada están en [`mejora4/`](mejora4/): `antes-{app}.json` y `despues-{app}.json`. **Por instrucción del operador, al terminar esta etapa se mantuvo 1 vCPU / 2 GiB y 2 réplicas fijas en ambas apps; no se ejecutó `restaurar`.** La configuración anterior también quedó guardada por el script en `~/.cafeorbe-ren01-estado` de esta sesión de Cloud Shell.

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

**Estado al finalizar esta etapa:** ambas apps quedaron en 1 vCPU / 2 GiB, mínimo y máximo 2 réplicas, por instrucción explícita del operador. Las comprobaciones finales de recursos y readiness se guardan en `mejora4/final-{app}.json` y `mejora4/readiness-final.json`.

## Mejora 4b: cuatro réplicas de 0,5 vCPU / 1 GiB

Continuación del **17 nov 2026 (UTC)**: se compara la etapa anterior de 2 réplicas de 1 vCPU / 2 GiB con **4 réplicas fijas de 0,5 vCPU / 1 GiB** en `auction-service` y `realtime-gateway`. El total asignado por servicio permanece en **2 vCPU y 4 GiB**. El objetivo es mantener tres réplicas sanas cuando se detiene una, en lugar de una sola.

Se usó el mismo código de infra (`3695513`), las mismas sondas y la misma política de reconexión. No se modificaron servicios, web ni generador de carga. Los únicos cambios de configuración fueron:

```bash
az containerapp update -n auction-service -g cafeorbe-org --cpu 0.5 --memory 1Gi --min-replicas 4 --max-replicas 4
az containerapp update -n realtime-gateway -g cafeorbe-org --cpu 0.5 --memory 1Gi --min-replicas 4 --max-replicas 4
```

Antes de iniciar se confirmaron **4 réplicas listas y readiness UP por servicio**. Se ejecutaron tres corridas consecutivas desde Azure Cloud Shell: 60 compradores nuevos por corrida, subasta de 10 minutos, 5 pujas/s y caída de una réplica de cada servicio a los 30 s, con 90 s de observación posteriores. El sondeo paralelo conservó la metodología de la etapa anterior; aquí se exige reinicio confirmado de la víctima y **cuatro** réplicas con `ready=true` por servicio. Sus tiempos son cotas superiores observadas.

El script original no se alteró: su criterio de reposición sigue exigiendo un mínimo de dos réplicas. La recuperación de las cuatro se demuestra por separado con los sondeos NDJSON, las cuatro entradas por servicio en `reposicion.replicas` y las comprobaciones inicial/final. Los archivos `resultado-caos-*.json` originales permanecen también en `~/cafeorbe-infra/verificacion/dis01/` de Cloud Shell.

### Cuatro réplicas, corrida 1: `2a312409-c462-4366-8841-0339dc580c05`

| Medición | Resultado |
|---|---|
| Falla (UTC) | 2026-11-17T02:52:13.877Z |
| Reposición, línea del script | 02:54:07.514 UTC; +113.6 s |
| Auction: reinicio confirmado y 4 réplicas listas | 02:53:09.840 UTC; **+56.0 s**; muestra previa aún sin cumplir: +48.0 s |
| Realtime: reinicio confirmado y 4 réplicas listas | 02:53:02.987 UTC; **+49.1 s**; muestra previa aún sin cumplir: +41.1 s |
| WebSocket | 14 cortes; reconexión máxima **2.530 s** |
| REST en los 30 s tras la falla | **0 %** (0/61); p95 **408 ms**; máxima 2784 ms |
| Pujas | 599 enviadas; 164 aceptadas; **0 perdidas y 0 fantasma**; 38 sin respuesta (dato informativo) |
| Cierre y wallet | **FINALIZADA, 1 evento de cierre, 1 COBRO, 1 ABONO_VENTA; `cumple: true`** |

| Criterio del script original | Resultado |
|---|---|
| Errores REST en los 30 s tras la falla < 2 % | ✅ |
| Reconexión WebSocket < 10 s | ✅ |
| 0 pujas aceptadas perdidas | ✅ |
| Réplicas repuestas (2 por servicio, sin la caída) | ✅ |

Intentos fallidos y reconexiones de 5 s o más (si no aparece ninguna reconexión, todas fueron menores de 5 s):

```text
Intentos fallidos: 5 · {"conexion · no abrió en 1500 ms":4,"conexion · no abrió en 800 ms":1}
```

Salida JSON de `bash verificar-cierre.sh 2a312409-c462-4366-8841-0339dc580c05`:

```json
{"subasta": "2a312409-c462-4366-8841-0339dc580c05", "estado": "FINALIZADA", "conGanador": true, "eventosDeCierre": 1, "movimientosWallet": {"ABONO_VENTA": 1, "COBRO": 1}, "cumple": true}
```

Evidencia: [resultado original](resultado-caos-2026-11-17T025143877Z.json), [log del caos](mejora4-4replicas/caos-1.log), [verificador de cierre](mejora4-4replicas/cierre-1.log), [réplicas auction](mejora4-4replicas/replicas-1-auction-service.ndjson) y [réplicas realtime](mejora4-4replicas/replicas-1-realtime-gateway.ndjson).

### Cuatro réplicas, corrida 2: `928a9147-907c-4828-b89d-fe3cbbb15340`

| Medición | Resultado |
|---|---|
| Falla (UTC) | 2026-11-17T03:02:54.482Z |
| Reposición, línea del script | 03:05:03.332 UTC; +128.8 s |
| Auction: reinicio confirmado y 4 réplicas listas | 03:03:53.935 UTC; **+59.5 s**; muestra previa aún sin cumplir: +51.3 s |
| Realtime: reinicio confirmado y 4 réplicas listas | 03:03:44.914 UTC; **+50.4 s**; muestra previa aún sin cumplir: +41.8 s |
| WebSocket | 11 cortes; reconexión máxima **2.516 s** |
| REST en los 30 s tras la falla | **0 %** (0/69); p95 **317 ms**; máxima 513 ms |
| Pujas | 599 enviadas; 172 aceptadas; **0 perdidas y 0 fantasma**; 39 sin respuesta (dato informativo) |
| Cierre y wallet | **FINALIZADA, 1 evento de cierre, 1 COBRO, 1 ABONO_VENTA; `cumple: true`** |

| Criterio del script original | Resultado |
|---|---|
| Errores REST en los 30 s tras la falla < 2 % | ✅ |
| Reconexión WebSocket < 10 s | ✅ |
| 0 pujas aceptadas perdidas | ✅ |
| Réplicas repuestas (2 por servicio, sin la caída) | ✅ |

Intentos fallidos y reconexiones de 5 s o más (si no aparece ninguna reconexión, todas fueron menores de 5 s):

```text
Intentos fallidos: 4 · {"conexion · no abrió en 1500 ms":4}
```

Salida JSON de `bash verificar-cierre.sh 928a9147-907c-4828-b89d-fe3cbbb15340`:

```json
{"subasta": "928a9147-907c-4828-b89d-fe3cbbb15340", "estado": "FINALIZADA", "conGanador": true, "eventosDeCierre": 1, "movimientosWallet": {"ABONO_VENTA": 1, "COBRO": 1}, "cumple": true}
```

Evidencia: [resultado original](resultado-caos-2026-11-17T030224482Z.json), [log del caos](mejora4-4replicas/caos-2.log), [verificador de cierre](mejora4-4replicas/cierre-2.log), [réplicas auction](mejora4-4replicas/replicas-2-auction-service.ndjson) y [réplicas realtime](mejora4-4replicas/replicas-2-realtime-gateway.ndjson).

### Cuatro réplicas, corrida 3: `e70295b8-4af8-495b-a70f-ae3ac84b0e0b`

| Medición | Resultado |
|---|---|
| Falla (UTC) | 2026-11-17T03:13:41.160Z |
| Reposición, línea del script | 03:15:36.257 UTC; +115.1 s |
| Auction: reinicio confirmado y 4 réplicas listas | 03:14:40.122 UTC; **+59.0 s**; muestra previa aún sin cumplir: +50.1 s |
| Realtime: reinicio confirmado y 4 réplicas listas | 03:14:29.598 UTC; **+48.4 s**; muestra previa aún sin cumplir: +39.7 s |
| WebSocket | 14 cortes; reconexión máxima **4.458 s** |
| REST en los 30 s tras la falla | **0 %** (0/55); p95 **1488 ms**; máxima 1526 ms |
| Pujas | 599 enviadas; 172 aceptadas; **0 perdidas y 0 fantasma**; 43 sin respuesta (dato informativo) |
| Cierre y wallet | **FINALIZADA, 1 evento de cierre, 1 COBRO, 1 ABONO_VENTA; `cumple: true`** |

| Criterio del script original | Resultado |
|---|---|
| Errores REST en los 30 s tras la falla < 2 % | ✅ |
| Reconexión WebSocket < 10 s | ✅ |
| 0 pujas aceptadas perdidas | ✅ |
| Réplicas repuestas (2 por servicio, sin la caída) | ✅ |

Intentos fallidos y reconexiones de 5 s o más (si no aparece ninguna reconexión, todas fueron menores de 5 s):

```text
Intentos fallidos: 6 · {"conexion · no abrió en 1500 ms":6}
```

Salida JSON de `bash verificar-cierre.sh e70295b8-4af8-495b-a70f-ae3ac84b0e0b`:

```json
{"subasta": "e70295b8-4af8-495b-a70f-ae3ac84b0e0b", "estado": "FINALIZADA", "conGanador": true, "eventosDeCierre": 1, "movimientosWallet": {"ABONO_VENTA": 1, "COBRO": 1}, "cumple": true}
```

Evidencia: [resultado original](resultado-caos-2026-11-17T031311161Z.json), [log del caos](mejora4-4replicas/caos-3.log), [verificador de cierre](mejora4-4replicas/cierre-3.log), [réplicas auction](mejora4-4replicas/replicas-3-auction-service.ndjson) y [réplicas realtime](mejora4-4replicas/replicas-3-realtime-gateway.ndjson).

### Comparación y conclusión

| Configuración por servicio | Capacidad total | WS máximo por corrida | REST por corrida | Corridas con 4/4 criterios |
|---|---|---|---|---|
| 2 × 1 vCPU / 2 GiB | 2 vCPU / 4 GiB | 6,123 / 6,402 / 12,458 s | 1,67 / 0 / 4,35 % | 2/3 |
| 4 × 0,5 vCPU / 1 GiB | 2 vCPU / 4 GiB | 2.530 / 2.516 / 4.458 s | 0 / 0 / 0 % | **3/3** |

**Las tres corridas con cuatro réplicas cumplen los cuatro criterios medidos y la comprobación de cierre/cobro/abono.** Esta configuración satisface los umbrales de DIS-01 en las tres repeticiones, a diferencia de la etapa con dos réplicas. Tener tres réplicas sanas durante la falla muestra un mejor resultado en estas pruebas que concentrar la misma capacidad total en dos réplicas.

Con 0,5 vCPU, auction volvió a observarse lista a los **56.0–59.5 s** y realtime a los **48.4–50.4 s**, frente a 45,3–51,9 s y 35,9–46,0 s respectivamente con 1 vCPU. Se conserva la distinción entre recuperación observada por sondeo y la línea tardía de reposición del script.

La comparación modifica CPU, memoria por réplica y cantidad de réplicas conjuntamente, manteniendo la capacidad total asignada; no permite aislar el efecto individual de cada factor. Tres repeticiones no garantizan el resultado de todas las fallas futuras, ni demuestran que el ingreso haya dejado de dirigir tráfico a contenedores que reinician.

**Configuración final vigente:** `auction-service` y `realtime-gateway` quedan con **4 réplicas fijas de 0,5 vCPU / 1 GiB cada una**, por la autorización del operador para esta prueba. La comprobación final confirma cuatro réplicas listas y readiness UP por app. Evidencia en [`mejora4-4replicas/readiness-final.json`](mejora4-4replicas/readiness-final.json), `final-{app}.json` y `replicas-final-{app}.json`. Los snapshots `antes-{app}.json` conservan la configuración de dos réplicas de 1 vCPU; el estado original de 0,25 vCPU sigue conservado en la etapa anterior y en `~/.cafeorbe-ren01-estado` de Cloud Shell. No se ejecutó restauración.

## Duración de las próximas corridas: 3 minutos por subasta

Por indicación del operador, las próximas preparaciones de DIS-01 usan **3 minutos por subasta**:

```bash
cd ~/cafeorbe-infra/verificacion/ren01
node preparar-ren01.mjs --compradores 60 --minutos 3
export REN01_SUBASTA=$(cat .subasta-ren01)
cd ../dis01
node caos-bajo-carga.mjs
# Al cerrar la subasta:
bash verificar-cierre.sh "$REN01_SUBASTA"
```

Se conservan los 30 s previos a la falla y los 90 s posteriores. En las seis corridas documentadas, esa carga habría terminado antes de un cierre a los 3 minutos; las consultas de reposición y la verificación de cierre pueden finalizar después. La duración total incluye además preparación y consultas de Azure. Cada tanda debe guardar su evidencia en un directorio nuevo.

Las etapas Mejora 4 y Mejora 4b corresponden a subastas de 10 minutos. La validación con subastas de 3 minutos se documenta a continuación. Este parámetro se pasa explícitamente para DIS-01 y no cambia el valor predeterminado de preparación de REN-01.

## Validación con subastas de 3 minutos

Tanda del **17 nov 2026 (UTC)**: tres nuevas corridas con `node preparar-ren01.mjs --compradores 60 --minutos 3`, manteniendo **4 réplicas fijas de 0,5 vCPU / 1 GiB** en auction y realtime. Se conservan 5 pujas/s, 30 s antes de la falla y 90 s después. Código de infra `3695513`; sin cambios del generador, servicios, sondas ni política de reconexión.

Las 4 réplicas por servicio estaban listas antes de comenzar. La carga termina antes del cierre a los 3 minutos; la comprobación de reposición y las consultas de cierre pueden finalizar después. El sondeo complementario conserva el mismo formato y, si al terminar el generador aún no hay cuatro réplicas listas, continúa hasta confirmarlas o agotar 180 s adicionales.

El contador auxiliar del ejecutor rechazó inicialmente las fechas ISO con guiones y marcó por error las primeras corridas como inválidas. El generador original confirmó los reinicios y sus resultados se conservaron sin cambios. Se verificaron por separado las fechas, las cuatro réplicas, los criterios y el cierre de cada subasta, y se detuvo el bucle tras la tercera corrida para evitar repeticiones innecesarias. El clasificador se corrigió para las ejecuciones posteriores. [Nota de control del ejecutor](mejora4-4replicas-3min-20261117T033752Z/control-ejecutor.txt).

### Tres minutos, corrida 1: `349acc15-bea2-42fb-b770-5dd705b79a83`

| Medición | Resultado |
|---|---|
| Falla (UTC) | 2026-11-17T03:39:28.130Z |
| Reposición, línea del script | 03:41:21.925 UTC; +113.8 s |
| Auction: reinicio confirmado y 4 réplicas listas | 03:40:28.035 UTC; **+59.9 s**; muestra previa aún sin cumplir: +51.3 s |
| Realtime: reinicio confirmado y 4 réplicas listas | 03:40:17.592 UTC; **+49.5 s**; muestra previa aún sin cumplir: +41.0 s |
| WebSocket | 20 cortes; reconexión máxima **6.206 s** |
| REST en los 30 s tras la falla | **0 %** (0/56); p95 **1473 ms**; máxima 1510 ms |
| Pujas | 599 enviadas; 173 aceptadas; **0 perdidas y 0 fantasma**; 43 sin respuesta (dato informativo) |
| Cierre y wallet | **FINALIZADA, 1 evento de cierre, 1 COBRO, 1 ABONO_VENTA; `cumple: true`** |

| Criterio del script original | Resultado |
|---|---|
| Errores REST en los 30 s tras la falla < 2 % | ✅ |
| Reconexión WebSocket < 10 s | ✅ |
| 0 pujas aceptadas perdidas | ✅ |
| Réplicas repuestas (2 por servicio, sin la caída) | ✅ |

Intentos fallidos y reconexiones de 5 s o más (si no aparece ninguna reconexión, todas fueron menores de 5 s):

```text
Intentos fallidos: 9 · {"conexion · no abrió en 1500 ms":9}
  6206 ms (corte 03:39:36.650): 36.876 conexion/no abrió en 1500 ms (1787 ms) → 38.923 conexion/no abrió en 1500 ms (1585 ms) → 40.713 conexion/no abrió en 1500 ms (1593 ms)
```

Salida JSON de `bash verificar-cierre.sh 349acc15-bea2-42fb-b770-5dd705b79a83`:

```json
{"subasta": "349acc15-bea2-42fb-b770-5dd705b79a83", "estado": "FINALIZADA", "conGanador": true, "eventosDeCierre": 1, "movimientosWallet": {"ABONO_VENTA": 1, "COBRO": 1}, "cumple": true}
```

Evidencia: [resultado original](resultado-caos-2026-11-17T033858130Z.json), [log del caos](mejora4-4replicas-3min-20261117T033752Z/caos-1.log), [verificador de cierre](mejora4-4replicas-3min-20261117T033752Z/cierre-1.log), [réplicas auction](mejora4-4replicas-3min-20261117T033752Z/replicas-1-auction-service.ndjson) y [réplicas realtime](mejora4-4replicas-3min-20261117T033752Z/replicas-1-realtime-gateway.ndjson).

### Tres minutos, corrida 2: `8dc9e40a-3861-4c7f-9b66-e744268c0090`

| Medición | Resultado |
|---|---|
| Falla (UTC) | 2026-11-17T03:43:12.550Z |
| Reposición, línea del script | 03:45:07.653 UTC; +115.1 s |
| Auction: reinicio confirmado y 4 réplicas listas | 03:44:21.119 UTC; **+68.6 s**; muestra previa aún sin cumplir: +60.6 s |
| Realtime: reinicio confirmado y 4 réplicas listas | 03:44:08.424 UTC; **+55.9 s**; muestra previa aún sin cumplir: +46.9 s |
| WebSocket | 19 cortes; reconexión máxima **2.627 s** |
| REST en los 30 s tras la falla | **0 %** (0/66); p95 **499 ms**; máxima 896 ms |
| Pujas | 599 enviadas; 175 aceptadas; **0 perdidas y 0 fantasma**; 60 sin respuesta (dato informativo) |
| Cierre y wallet | **FINALIZADA, 1 evento de cierre, 1 COBRO, 1 ABONO_VENTA; `cumple: true`** |

| Criterio del script original | Resultado |
|---|---|
| Errores REST en los 30 s tras la falla < 2 % | ✅ |
| Reconexión WebSocket < 10 s | ✅ |
| 0 pujas aceptadas perdidas | ✅ |
| Réplicas repuestas (2 por servicio, sin la caída) | ✅ |

Intentos fallidos y reconexiones de 5 s o más (si no aparece ninguna reconexión, todas fueron menores de 5 s):

```text
Intentos fallidos: 8 · {"conexion · no abrió en 1500 ms":8}
```

Salida JSON de `bash verificar-cierre.sh 8dc9e40a-3861-4c7f-9b66-e744268c0090`:

```json
{"subasta": "8dc9e40a-3861-4c7f-9b66-e744268c0090", "estado": "FINALIZADA", "conGanador": true, "eventosDeCierre": 1, "movimientosWallet": {"ABONO_VENTA": 1, "COBRO": 1}, "cumple": true}
```

Evidencia: [resultado original](resultado-caos-2026-11-17T034242548Z.json), [log del caos](mejora4-4replicas-3min-20261117T033752Z/caos-2.log), [verificador de cierre](mejora4-4replicas-3min-20261117T033752Z/cierre-2.log), [réplicas auction](mejora4-4replicas-3min-20261117T033752Z/replicas-2-auction-service.ndjson) y [réplicas realtime](mejora4-4replicas-3min-20261117T033752Z/replicas-2-realtime-gateway.ndjson).

### Tres minutos, corrida 3: `e4199306-d6b9-4928-b0a9-d089a8ae583b`

| Medición | Resultado |
|---|---|
| Falla (UTC) | 2026-11-17T03:46:59.144Z |
| Reposición, línea del script | 03:48:52.852 UTC; +113.7 s |
| Auction: reinicio confirmado y 4 réplicas listas | 03:48:25.637 UTC; **+86.5 s**; muestra previa aún sin cumplir: +78.3 s |
| Realtime: reinicio confirmado y 4 réplicas listas | 03:48:12.515 UTC; **+73.4 s**; muestra previa aún sin cumplir: +65.7 s |
| WebSocket | 13 cortes; reconexión máxima **2.603 s** |
| REST en los 30 s tras la falla | **0 %** (0/60); p95 **1447 ms**; máxima 2815 ms |
| Pujas | 599 enviadas; 177 aceptadas; **0 perdidas y 0 fantasma**; 91 sin respuesta (dato informativo) |
| Cierre y wallet | **FINALIZADA, 1 evento de cierre, 1 COBRO, 1 ABONO_VENTA; `cumple: true`** |

| Criterio del script original | Resultado |
|---|---|
| Errores REST en los 30 s tras la falla < 2 % | ✅ |
| Reconexión WebSocket < 10 s | ✅ |
| 0 pujas aceptadas perdidas | ✅ |
| Réplicas repuestas (2 por servicio, sin la caída) | ✅ |

Intentos fallidos y reconexiones de 5 s o más (si no aparece ninguna reconexión, todas fueron menores de 5 s):

```text
Intentos fallidos: 3 · {"conexion · no abrió en 1500 ms":3}
```

Salida JSON de `bash verificar-cierre.sh e4199306-d6b9-4928-b0a9-d089a8ae583b`:

```json
{"subasta": "e4199306-d6b9-4928-b0a9-d089a8ae583b", "estado": "FINALIZADA", "conGanador": true, "eventosDeCierre": 1, "movimientosWallet": {"ABONO_VENTA": 1, "COBRO": 1}, "cumple": true}
```

Evidencia: [resultado original](resultado-caos-2026-11-17T034629143Z.json), [log del caos](mejora4-4replicas-3min-20261117T033752Z/caos-3.log), [verificador de cierre](mejora4-4replicas-3min-20261117T033752Z/cierre-3.log), [réplicas auction](mejora4-4replicas-3min-20261117T033752Z/replicas-3-auction-service.ndjson) y [réplicas realtime](mejora4-4replicas-3min-20261117T033752Z/replicas-3-realtime-gateway.ndjson).

### Resultado de la tanda corta

**3/3 corridas cumplen los cuatro criterios medidos.** Las tres subastas quedaron FINALIZADAS, con exactamente un evento de cierre, un COBRO y un ABONO_VENTA; `cumple: true`.

| Falla UTC | Reconexión máxima | REST 30 s | p95 REST | Criterios |
|---|---|---|---|---|
| 03:39:28.130 | 6.206 s | 0 % (0/56) | 1473 ms | 4/4 |
| 03:43:12.550 | 2.627 s | 0 % (0/66) | 499 ms | 4/4 |
| 03:46:59.144 | 2.603 s | 0 % (0/60) | 1447 ms | 4/4 |

La observación de carga de 90 s posteriores a la falla terminó nominalmente entre **36.4 y 37.4 s antes** del cierre programado. Se mantuvieron los 599 envíos por corrida del generador. Las tres duraciones reducidas conservaron la ventana completa de medición.

Auction volvió a observarse con cuatro réplicas listas a los **59.9–86.5 s** tras la falla y realtime a los **49.5–73.4 s**. Son cotas superiores del sondeo, no el instante exacto de recuperación.

**Configuración final:** se mantienen cuatro réplicas de 0,5 vCPU / 1 GiB por app, todas listas y readiness UP. La verificación final está en [readiness-final.json](mejora4-4replicas-3min-20261117T033752Z/readiness-final.json), junto con snapshots de recursos y réplicas. La capacidad total asignada no cambió: 2 vCPU y 4 GiB por servicio.

Las nuevas mediciones se suman a las tres corridas anteriores de 10 minutos con cuatro réplicas. Tres repeticiones con duración reducida no garantizan todos los fallos futuros. Se conserva el p95 medido en cada corrida; no se certifican aquí otros escenarios de rendimiento.


## Corridas del 19 nov 2026 con 2–4 réplicas de 0,5 vCPU (configuración del PDF)

Topología en QA después de integrar auction #18, realtime #16 e infra #25: `auction-service`, `realtime-gateway` y `api-gateway` en **2–4 réplicas**. Auction y realtime con 0,5 vCPU / 1 GiB y regla `http-concurrency` de 20; sondas Startup, Liveness y Readiness. Antes de las pruebas, PROD bajó a 2–4 para liberar núcleos: se usaron 6,5 de 10 ([escalado-20261118](escalado-20261118/)). Todo se ejecutó desde Azure Cloud Shell sobre `main` de infra (`b2c0344`). La regresión `probar-topologia.py` pasó 6 de 6.

### Caída de réplicas bajo carga: tres corridas, se reportan todas

Cada corrida usó 60 compradores, 5 pujas/s y una subasta de 4 minutos. A los 30 s se detuvo una réplica de auction y una de realtime, y se observó 90 s más.

| Corrida | Subasta | Falla (UTC) | REST 30 s tras la falla | WebSocket | Pujas perdidas / fantasma | Réplicas repuestas | Cierre y cobro |
|---|---|---|---|---|---|---|---|
| 1 | `03d8d9bd-c68f-45e8-935b-64f3d03f946d` | 12:29:31 | ❌ 3,51 % (2/57; p95 807 ms) | ❌ 36 cortes, máx. 12,4 s | ✅ 0 / 0 | ✅ | ✅ 1 cierre, 1 COBRO, 1 ABONO_VENTA |
| 2 | `f6ef783d-9831-43a0-910e-4fe588b8c0fc` | 12:32:34 | ❌ 2,22 % (1/45; p95 1498 ms) | ❌ 22 cortes, máx. 25,4 s | ✅ 0 / 0 | ✅ | ✅ 1 cierre, 1 COBRO, 1 ABONO_VENTA |
| 3 | `b481decb-4786-449e-86f8-abd0436a8f18` | 12:35:39 | ✅ 0 % (0/58; p95 1462 ms) | ❌ 16 cortes, máx. 12,3 s | ✅ 0 / 0 | ✅ | ✅ 1 cierre, 1 COBRO, 1 ABONO_VENTA |

**Resultado: 0 de 3 corridas cumplen todas las medidas.** Se cumplen siempre la conservación de pujas y el cierre y cobro únicos. La reconexión menor a 10 s no se cumplió en ninguna corrida y los errores REST, en dos. Los intentos fallidos son todos de conexión: el ingreso sigue enviando ≈ 50 % de los intentos a la réplica que reinicia. Con 0,5 vCPU la réplica tarda más en volver que con 1 vCPU (17 nov: 2 de 3), y con 4 réplicas (17 nov: 6 de 6) la fracción de intentos perdidos baja a ≈ 25 %.

### Escalado con la carga duplicada: no escaló

`carga-sala.mjs --usuarios 400 --tasa 40 --duracion 300` sobre la subasta `525b5113-ebc0-4440-b3a2-f6fc5d753091`, el doble de REN-01. Un observador registró las réplicas cada 15 s durante la carga y 2 minutos después.

| Medida | Resultado |
|---|---|
| Réplicas de auction, realtime y api-gateway | **2 en las 24 muestras de cada servicio**: no se agregó ninguna |
| Pujas enviadas / por segundo | 12.000 / 40,00 |
| WebSocket | 400 conectados, **77 desconexiones** |
| Latencia p50 / p95 / p99 | 3002 / 5145 / 5682 ms |
| Duplicados, desorden y gaps | 0 / 0 / 0 |

**DIS-01, «si la carga sube, se agregan réplicas hasta 4»: no cumple.** La regla `http-concurrency` de 20 no se disparó con 400 WebSockets ni con 40 pujas/s. Las pujas viajan por WebSocket y no como peticiones HTTP concurrentes al ingreso, y las llamadas internas a auction son cortas. Hace falta una regla basada en CPU o en conexiones para demostrar el escalado.

### Evidencia

Los logs, los JSON de resultado y el muestreo de réplicas están en el paquete `evidencia-dis01-ren01-20261119.tar.gz`, generado en Cloud Shell. Ese Cloud Shell no tiene almacenamiento persistente: el paquete se conserva fuera del repositorio.


## Correcciones del 19 nov y nuevas corridas: DIS-01 cumple con 2–4 réplicas

### Qué se corrigió

| Falla | Causa | Corrección |
|---|---|---|
| Reconexión de 12–25 s | Mientras la réplica caída reinicia, el ingreso le manda la mitad de los intentos y quedan colgados. Con un intento por ronda, la ronda falla el 50 % de las veces | **Conexión de respaldo** (web#10 y este generador): en la ventana rápida, si la conexión no abre en 400 ms se abre otra en paralelo con su propio ticket y gana la primera. La ronda falla solo si las dos caen en la réplica caída (25 %) |
| REST con 2,2–3,5 % de errores | Gateway con límite de 1,2 s y 4 reintentos: 1 de cada 32 lecturas sin respuesta | **Gateway con 0,8 s y 9 reintentos** (api-gateway#10; en QA ya como variables de entorno): ~1 de cada 1000 |
| No escalaba con la carga duplicada | El ambiente es *express*: solo admite la regla HTTP (CPU y TCP se rechazan con `ExpressCustomScaleRulesNotSupported`). La CPU tampoco crece: 12–20 % con carga normal y con carga duplicada, porque el límite es PostgreSQL y el bloqueo de la fila | **Regla HTTP de auction en 10 peticiones concurrentes por réplica.** Cada puja llega de realtime como POST; con la carga duplicada hace fila en el bloqueo y la concurrencia supera el umbral |

### Caída de réplicas: 3 de 3 corridas cumplen

Mismo procedimiento que antes: 60 compradores, 5 pujas/s, se detiene 1 de 2 réplicas de auction y 1 de 2 de realtime a los 30 s.

| Corrida | Subasta | REST 30 s tras la falla | Reconexión máx. | Respaldos abiertos / ganadores | Pujas perdidas / fantasma | Réplicas repuestas | Cierre y cobro |
|---|---|---|---|---|---|---|---|
| 1 | `7971ffbe-92db-419c-9e39-9a15f42ecf16` | ✅ 0 % (0/47) | ✅ 4,19 s (24 cortes) | 13 / 7 | ✅ 0 / 0 | ✅ | ✅ 1 cierre, 1 COBRO, 1 ABONO_VENTA |
| 2 | `2792842c-963d-4031-aee0-0c511be5afd3` | ✅ 0 % (0/55) | ✅ 4,63 s (13 cortes) | 33 / 17 | ✅ 0 / 0 | ✅ | ✅ 1 cierre, 1 COBRO, 1 ABONO_VENTA |
| 3 | `9d68511e-a860-4793-8c73-f49749552af5` | ✅ 0 % (0/46) | ✅ 4,63 s (16 cortes) | 20 / 11 | ✅ 0 / 0 | ✅ | ✅ 1 cierre, 1 COBRO, 1 ABONO_VENTA |

Antes de las correcciones, ese mismo día: 0 de 3 (reconexión de 12,4, 25,4 y 12,3 s).

### Escalado con la carga duplicada: auction pasa de 2 a 4

`carga-sala.mjs --usuarios 400 --tasa 40 --duracion 180` sobre la subasta `4c652393-2851-42bd-8387-7f52b1ca9f58`, con la regla HTTP de 10 en auction.

| Medida | Resultado |
|---|---|
| Réplicas de auction | **2 → 4** a los ~2,5 min de carga sostenida (14:04:20 UTC); realtime y api-gateway en 2 |
| WebSocket | 400 conectados, **0 desconexiones** |
| Pujas | 7200 enviadas a 40,00/s |
| Duplicados, desorden y gaps | 0 / 0 / 0 |
| Latencia p50 / p95 / p99 | 748 / 3180 / 4288 ms (con el doble de la carga de REN-01; no es criterio de DIS-01) |

Corrida anterior con la regla en 20, la misma mañana: las réplicas se quedaron en 2.
