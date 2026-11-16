# REN-01: evidencia QA para revision

**Dictamen observado: NO CUMPLE.** No cierra REN-01 ni modifica servicios desplegados.

Corrida UTC: 2026-11-16 13:28:02 a 13:38:02. Auction `f6e5971b5a973cdbca71a1d0616e50587de6e5fa`, realtime `ren01-perf`; dos replicas por servicio de 0,25 vCPU.

| Criterio | Resultado |
|---|---|
| 200 WebSockets durante 600 s | Cumple |
| Caidas, duplicados, desorden y gaps | 0 |
| Entrega completa | 974 pujas x 200 receptores = 194.800 muestras |
| Ganador unico por incremento | 974 incrementos / 974 filas unicas en PostgreSQL |
| p95 <=800 ms | **815,78 ms: no cumple** |
| p99 <=1500 ms | 871,24 ms: cumple |
| 20 intentos/s sostenidos | 11.994/12.000; el generador no completo la carga exacta |
| PostgreSQL | 13 conexiones iniciales; muestras entre 11 y 16 |
| CPU por replica <80% | **No verificado**: Azure devolvio `timeseries: []` |

Informe, consultas crudas de CPU, resumen, muestras y graficas: [corrida conservada](evidencia-ren01/corrida-20261116T132531Z/INFORME.md).

## Revisar

1. Medicion de todos los receptores: cada aceptada debe aparecer en los 200 sockets, conciliada con PostgreSQL, incluidos primer y ultimo evento. Los rechazos no se mezclan en el percentil de aceptadas. Intentos sin respuesta o errores impiden aprobar.
2. Planificacion de carga: faltaron seis envios. No relajar el umbral tras observar el resultado; corregir el generador y repetir. Esta limitacion no demuestra falta de capacidad del backend.
3. CPU: GET REST a Azure Monitor ejecutado correctamente, pero sin series en la ventana. No interpretar ausencia de datos como uso cero. El lanzador evita az.cmd para conservar la URL completa en Windows.
4. Candidato de rendimiento aun NO aplicado: el main desplegado de auction define outbox a 200 ms y no referencia OUTBOX_INTERVALO_MS, frente a los 25 ms usados anteriormente. Comprobar overrides efectivos en QA antes de proponer el cambio y medirlo aislado. No se atribuye todo el retraso a outbox sin evidencia por etapa.

La primera recepcion por puja tuvo p95 798,10 ms y la ultima 826,18 ms. El p95 de la diferencia primero-ultimo fue 41,36 ms. Son distribuciones distintas; no deben restarse sus percentiles para estimar tiempos internos.

## Ejecutar verificaciones locales

Node.js con WebSocket global (la corrida uso v24.20.0) y Python. Desde esta carpeta:

```powershell
node --test evidencia-ren01/analizar-carga.test.mjs
node --check carga-sala.mjs
```

Los ocho casos del evaluador pasaron. Tambien se ejecuto un fixture SIN RED del generador: dos envios, cuatro recepciones medidas y cierre intencional sin caidas. No se publica como evidencia QA. La prueba PowerShell del recolector no se pudo ejecutar en el sandbox por politica de firma; se verifico sintaxis y el paso real de la URL como argumento unico al Python de Azure CLI.

## Repetir en QA

Colocar localmente `compradores.json` (200 objetos con `id` y `token` vigentes, sin versionarlo) en esta carpeta. Desde PowerShell autenticado con permisos de lectura a QA, ejecutar:

```powershell
powershell -NoProfile -File .\evidencia-ren01\EJECUTAR-QA.ps1
```

El comando genera pujas reales de prueba solo contra la subasta QA indicada; no cambia escala ni imagenes. Consulta PostgreSQL en modo lectura con credenciales obtenidas de auction y nunca impresas, y usa pg8000 instalado en una carpeta temporal cuando falta. Conserva la corrida en una carpeta nueva. Leer [procedimiento y limites](evidencia-ren01/EJECUCION-FORMAL.md) antes de ejecutarlo. No se publica ningun workflow automatico de carga o despliegue.

Los archivos crudos completos de carga y PostgreSQL siguen en el workspace original: [SHA-256 y limitaciones de reproduccion](evidencia-ren01/corrida-20261116T132531Z/RAW-SHA256.json). El resumen publicado permite revisar resultados, pero volver a calcular la conciliacion original requiere esos archivos. Para una nueva corrida el ejecutor si conserva todos los originales y permite evaluarlos.
