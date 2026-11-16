# REN-01: NO CUMPLE

Ventana sostenida UTC: 2026-11-16T13:28:02.091Z — 2026-11-16T13:38:02.136Z.

| Criterio | Dictamen | Observado |
|---|---|---|
| Instrumentacion completa | CUMPLE | 2 |
| 200 WS durante toda la carga | CUMPLE | {"abiertasExitosas":200,"desconexiones":0,"erroresConexion":0,"picoConexionesActivas":200,"finalesActivas":200,"minimoDuranteCarga":200} |
| 600 s sostenidos | CUMPLE | {"inicioIso":"2026-11-16T13:28:02.091Z","finIso":"2026-11-16T13:38:02.136Z","duracionRealMs":600045.2894} |
| 20 pujas/s sostenidas (bloques de 10 s) | NO CUMPLE | {"enviadas":11994,"bloques10s":[200,200,200,200,200,198,200,200,200,200,200,200,200,200,200,200,197,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,199,201,200,199,199,201]} |
| p95 a todos <=800 ms | NO CUMPLE | 815.7753999999841 |
| p99 a todos <=1500 ms | CUMPLE | 871.2412999999942 |
| 0 caidas y errores | CUMPLE | {"conexiones":{"abiertasExitosas":200,"desconexiones":0,"erroresConexion":0,"picoConexionesActivas":200,"finalesActivas":200,"minimoDuranteCarga":200},"transporte":0,"aplicacion":0} |
| 0 duplicados/desorden/gaps observados | CUMPLE | {"duplicados":0,"desorden":0,"gaps":0} |
| Todos los intentos reconciliados | CUMPLE | {"pendientes":0,"noCorrelacionadas":0} |
| 1 fila ganadora por incremento en PostgreSQL | CUMPLE | {"delta":974,"filas":974,"montosUnicos":974} |
| Entrega completa a los 200, incluidos primer/ultimo evento | CUMPLE | {"completas":200,"delta":974,"muestras":194800,"socketsIncompletos":[]} |
| PostgreSQL <25 conexiones antes de carga | CUMPLE | 13 |
| Observador PostgreSQL sin errores | CUMPLE | [{"observadoEn":"2026-11-16 13:26:25.227723+00:00","conexionesCliente":13},{"observadoEn":"2026-11-16 13:26:52.651356+00:00","conexionesCliente":13},{"observadoEn":"2026-11-16 13:27:17.426065+00:00","conexionesCliente":13},{"observadoEn":"2026-11-16 13:27:46.809124+00:00","conexionesCliente":12},{"observadoEn":"2026-11-16 13:28:12.612308+00:00","conexionesCliente":12},{"observadoEn":"2026-11-16 13:28:39.799002+00:00","conexionesCliente":11},{"observadoEn":"2026-11-16 13:29:06.277628+00:00","conexionesCliente":12},{"observadoEn":"2026-11-16 13:29:32.199712+00:00","conexionesCliente":12},{"observadoEn":"2026-11-16 13:29:57.939709+00:00","conexionesCliente":14},{"observadoEn":"2026-11-16 13:30:23.350615+00:00","conexionesCliente":14},{"observadoEn":"2026-11-16 13:30:50.177036+00:00","conexionesCliente":15},{"observadoEn":"2026-11-16 13:31:15.026699+00:00","conexionesCliente":15},{"observadoEn":"2026-11-16 13:31:40.680550+00:00","conexionesCliente":16},{"observadoEn":"2026-11-16 13:32:05.887484+00:00","conexionesCliente":16},{"observadoEn":"2026-11-16 13:32:31.739485+00:00","conexionesCliente":15},{"observadoEn":"2026-11-16 13:32:59.094322+00:00","conexionesCliente":15},{"observadoEn":"2026-11-16 13:33:24.681634+00:00","conexionesCliente":15},{"observadoEn":"2026-11-16 13:33:50.126459+00:00","conexionesCliente":14},{"observadoEn":"2026-11-16 13:34:16.422761+00:00","conexionesCliente":14},{"observadoEn":"2026-11-16 13:34:42.115277+00:00","conexionesCliente":15},{"observadoEn":"2026-11-16 13:35:08.409917+00:00","conexionesCliente":15},{"observadoEn":"2026-11-16 13:35:36.502626+00:00","conexionesCliente":16},{"observadoEn":"2026-11-16 13:36:01.621976+00:00","conexionesCliente":16},{"observadoEn":"2026-11-16 13:36:27.847943+00:00","conexionesCliente":15},{"observadoEn":"2026-11-16 13:36:53.780702+00:00","conexionesCliente":16},{"observadoEn":"2026-11-16 13:37:20.107965+00:00","conexionesCliente":16},{"observadoEn":"2026-11-16 13:37:46.523848+00:00","conexionesCliente":15},{"observadoEn":"2026-11-16 13:38:12.404231+00:00","conexionesCliente":15}] |
| auction-service: dos replicas estables en muestreo | CUMPLE | {"replicas":["auction-service--latest-c7ada9d0-847a-4a94-baa0-06e42b928e78","auction-service--latest-de2594ee-1da8-4d10-b753-f30b7079309b"],"muestras":25,"intervaloMaximoSegundos":60} |
| auction-service/auction-service--latest-c7ada9d0-847a-4a94-baa0-06e42b928e78: CPU <80% | NO VERIFICADO | {"maximoPorcentaje":null,"muestras":0,"coberturaCompleta":false,"vcpu":0.25} |
| auction-service/auction-service--latest-de2594ee-1da8-4d10-b753-f30b7079309b: CPU <80% | NO VERIFICADO | {"maximoPorcentaje":null,"muestras":0,"coberturaCompleta":false,"vcpu":0.25} |
| realtime-gateway: dos replicas estables en muestreo | CUMPLE | {"replicas":["realtime-gateway--latest-5d7328a4-5898-4a76-9f18-582ce737d702","realtime-gateway--latest-67d83359-f0d8-4726-9295-e036817db829"],"muestras":25,"intervaloMaximoSegundos":60} |
| realtime-gateway/realtime-gateway--latest-5d7328a4-5898-4a76-9f18-582ce737d702: CPU <80% | NO VERIFICADO | {"maximoPorcentaje":null,"muestras":0,"coberturaCompleta":false,"vcpu":0.25} |
| realtime-gateway/realtime-gateway--latest-67d83359-f0d8-4726-9295-e036817db829: CPU <80% | NO VERIFICADO | {"maximoPorcentaje":null,"muestras":0,"coberturaCompleta":false,"vcpu":0.25} |

[Graficas de latencia y CPU](graficas.html). [Resumen de carga](resumen-carga.json). [CPU y criterios](aceptacion.json). Originales PostgreSQL y carga cruda conservados localmente: [hashes y limitaciones](RAW-SHA256.json). Replica y conexion BD: archivos NDJSON.

CPU: Maximum de Azure Monitor a PT1M, normalizado por vCPU configuradas. Estado de replicas muestreado, no monitor continuo. Latencia de pujas aceptadas desde envio hasta cada receptor; rechazos se contabilizan, sin mezclarlos en el percentil. La carga proviene de esta maquina y su red forma parte de la medicion punta a punta. Esta certificacion no depende de Grafana.
