# Ejecucion formal sin Grafana

Desde PowerShell habitual autenticado en Azure, en la raiz CafeOrbe:

```powershell
powershell -NoProfile -File .\evidencia-ren01\EJECUTAR-QA.ps1
```

Duracion aproximada: 13-16 minutos (conexion progresiva, calentamiento, 600 segundos sostenidos, drenaje y publicacion de Azure Monitor). El comando carga 200 compradores existentes contra la subasta QA indicada; genera pujas reales de prueba. No cambia imagenes, escala ni recursos, no despliega y no integra infra #4.

El ejecutor comprueba ambiente y salud otra vez; obtiene credenciales PostgreSQL de la configuracion de auction QA sin imprimirlas ni guardarlas. Instala pg8000 en una carpeta temporal local si falta, abre conexiones de solo lectura para baseline, muestras y cierre, y restaura las variables del proceso al salir. Las pujas de carga son las unicas escrituras de negocio. Ante fallo de acceso o >=25 conexiones cliente antes de carga aborta. El observador se incluye en ese conteo conservador.

Se guarda todo en `evidencia-ren01/corrida-<UTC>/`: `resultado-objetivo.json`, HTML diagnostico, log, muestras de replicas y conexiones, PostgreSQL antes/despues, CPU por replica, `aceptacion.json`, `INFORME.md` y `graficas.html`. Los resultados anteriores se conservan.

La fuente de aceptacion es `INFORME.md`/`aceptacion.json`, no las insignias parciales del HTML antiguo del generador. Se exige 200 WS, carga completa de 600 s y 12.000 envios con >=200 por cada bloque de 10 s; los intentos pendientes y mensajes ERROR impiden aprobar. No se descartan muestras lentas ni se mezclan rechazos rapidos con latencia de aceptadas. El generador conserva una muestra por receptor por cada puja aceptada; PostgreSQL debe conciliar los 200 receptores y un ganador por monto. Se rechazan claves repetidas de usuario/monto durante la corrida para no sobrescribir tiempos. Si no quedan emisores elegibles, la tasa insuficiente es visible y no se compensa con rafagas.

CPU se mide como Maximum a PT1M, dividido entre vCPU asignadas por replica; se exige cobertura de diez buckets de minuto por cada una de las cuatro replicas. Si Azure tarda en publicar o sus dimensiones no identifican las replicas, no hay certificacion. Puede recabarse otra vez la misma ventana con `RECABAR-CPU.ps1 -Inicio <UTC> -Fin <UTC> -Destino <corrida>` y reevaluar con `node evidencia-ren01/certificar.mjs <corrida>` sin repetir carga. Las replicas se muestrean cada aproximadamente 15 s mas el coste de consultas; huecos mayores de 60 s invalidan la cobertura.

Validacion local efectuada: ocho casos del evaluador (incluyen falsos positivos por eventos finales ausentes, filas ganadoras duplicadas, falta de carga, menos compradores y latencias vacias), mas fixture SIN RED del generador que comprueba dos envios y cuatro recepciones. No equivalen a una prueba remota ni certifican REN-01. `fixture-sin-red.*` son datos sinteticos claramente separados.

Referencia de resolucion de secretos: [Azure CLI, secret list --show-values](https://learn.microsoft.com/en-us/cli/azure/containerapp/secret?view=azure-cli-latest). No compartir credenciales en chat.
