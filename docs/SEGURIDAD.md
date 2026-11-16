# Seguridad · SEG-01, SEG-02 y SEG-03 en QA

Reporte de la verificación de los tres escenarios de seguridad aprobados (HU-25, HU-26 y HU-27) en el
ambiente QA de Azure Container Apps. Script: [`verificacion/seguridad-qa.mjs`](../verificacion/seguridad-qa.mjs).

## Cómo se ejecuta

La batería no usa Postman: es un script de Node.js que se puede repetir igual en cada corrida y que
comprueba las medidas de los escenarios, no solo los códigos HTTP. Necesita Node.js 22 y, en PowerShell:

```powershell
cd verificacion
$env:API_URL='https://api-gateway.<qa>.azurecontainerapps.io'
$env:WS_URL='wss://realtime-gateway.<qa>.azurecontainerapps.io'
$env:SIN_REGISTRO='1'                  # no publica en el broker: las personas de prueba quedan sin Orbes
$env:JWT_SECRET='<variable de entorno JWT_SECRET de la Container App>'
$env:INTERNAL_TOKEN='<variable de entorno INTERNAL_TOKEN>'   # opcional: lee las métricas de cada servicio
node seguridad-qa.mjs
```

Para la medida del login legítimo hay que entrar con Google en la web justo antes. Las sesiones de prueba las
firma [`sesiones-de-prueba.mjs`](../verificacion/sesiones-de-prueba.mjs) con `JWT_SECRET`, igual que identity:
no existe ningún acceso propio en la aplicación (SEG-01). El script sale con código 0 solo si todo cumple.

## Resultados en QA (2026-11-13 al 2026-11-15)

### SEG-01 · Autenticación con Google (HU-25)

| Medida del escenario | Resultado |
|---|---|
| 100 % de 10 o más intentos con tokens inválidos → 401 sin crear sesión | **11/11**: texto cualquiera, `alg: none`, HS256 con clave inventada, RS256 con llave ajena, `kid` inventado, vencido, otra audiencia (`aud`), otro emisor (`iss`), contenido alterado, correo sin verificar, firma truncada |
| 100 % de los inicios de sesión legítimos crea la sesión | Logins reales con Google desde https://cafeorbe-web.vercel.app |
| Login en menos de 3 s en p95 | **6/6** logins bajo 3 s (el más lento, 410 ms) |
| 100 % de los intentos fallidos registrado | `login_rechazado` en Log Analytics, con motivo, IP y correlationId |
| No hay login propio | `POST /api/sesion` por nombre → 401 |

### SEG-02 · Autorización (HU-26)

| Medida del escenario | Resultado |
|---|---|
| 100 % de una matriz de 10 o más casos negativos → 403 | **13/13**: Comprador crea, inicia o cambia reglas de una subasta, lista "mis subastas" o inicia la transmisión; otro Subastador cambia reglas, inicia o transmite una subasta ajena; Comprador con `X-User-Rol: SUBASTADOR` inventada; wallet `/internal` directo sin credencial, con `X-User-*` inventadas o con `X-Internal-Token` falso; auction directo sin credencial |
| Sin cambiar datos | La subasta queda igual (estado, reglas, ficha, fecha) y no se crea ninguna |
| Los casos legítimos pasan | Subastador dueño y Comprador → 200 |
| `/internal` no expuesto | El gateway responde 404 |
| Verificación en menos de 5 ms en p95 | Sesión en el gateway: **99,0 %** bajo 5 ms con 200 peticiones a ritmo normal (96,4 % acumulado con arranque y ráfagas). Credencial interna: **100 %** en identity, auction, wallet y streaming |
| Intentos registrados | `acceso_prohibido` (rol o propietario) y `acceso_interno_rechazado` en Log Analytics |

El gateway valida el token (firma, vencimiento, `jti`), descarta las cabeceras `X-User-*` del cliente y reenvía
el usuario y el rol verificados con la credencial interna. El 403 por rol o propietario lo aplica cada servicio,
porque comprobar el propietario requiere los datos de la subasta.

### SEG-03 · Resistencia a abuso (HU-27)

| Medida del escenario | Resultado |
|---|---|
| ≥ 99 % de los mensajes sobre el límite no llega a auction | **317/317** detenidos (100 %) |
| Bloqueo de 60 s tras 3 infracciones en 1 minuto | 16 de 16 atacantes cerrados con **4429** en ≤ 1,2 s; no pueden volver a entrar durante el bloqueo |
| El p95 de los usuarios legítimos empeora menos de 20 % | **−9,0 %** (688 ms sin ataque, 626 ms con ataque sostenido durante toda la medición) |
| Más de 5 conexiones del mismo usuario | La 6.ª se rechaza en el handshake |
| Mensajes de más de 1 KB | Cierre **1009** sin llegar a auction |
| Límite REST por usuario | 40 peticiones simultáneas: 20 atendidas y 20 con **429** + `Retry-After` |
| 0 caídas | api-gateway, realtime-gateway y auction-service siguen UP |
| Evento de seguridad y métrica | `infraccion` y `usuario_bloqueado` en Log Analytics; `cafeorbe_seguridad_infracciones_total` y `cafeorbe_seguridad_bloqueos_total` en el tablero técnico de Grafana |

Las latencias de las pujas se midieron desde fuera de Azure, por eso rondan 600–900 ms: SEG-03 compara contra
su propia línea base. La meta absoluta de latencia (REN-01) se mide desde la misma región de Azure.

## Registro en Log Analytics

Área de trabajo `cafeorbe-logs`, tabla `ContainerAppConsoleLogs_CL` (no aparece desde "Registros" del ambiente):

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(3h)
| extend j = parse_json(Log_s)
| where tostring(j.logger_name) == "cafeorbe.seguridad"
| summarize intentos = count() by app = ContainerAppName_s, evento = tostring(j.evento), motivo = tostring(j.motivo)
```

Cada línea lleva `evento`, `motivo`, `usuario`, `ip` y `correlationId`; nunca el token.

## Hallazgos corregidos durante la verificación

- El límite de pujas no se alcanzaba en QA: cada mensaje esperaba la respuesta de auction antes de leer el
  siguiente. Ahora el control se hace al llegar el mensaje y el reenvío va en hilos virtuales (realtime #8).
- Los eventos de seguridad de identity, auction, wallet, streaming y las infracciones del realtime se perdían en
  los logs JSON por un `correlationId` repetido (PRs del 2026-11-13).
- La verificación de sesión del gateway armaba el parser JWT en cada petición; ahora es único y se calienta al
  arrancar (api-gateway #6).
- identity no tenía buckets para medir el p95 del login (identity #7).
