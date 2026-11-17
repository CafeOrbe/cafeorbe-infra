# Balanceador de carga NGINX · restricción tecnológica de DIS-01

## Decisión

CaféOrbe usa un **balanceador de carga NGINX propio** (`cafeorbe-lb`) como único punto de entrada del navegador.
Es una restricción tecnológica de la arquitectura: el backend se escala horizontalmente agregando instancias
detrás del balanceador, y ninguna instancia recibe tráfico del navegador directamente.

La configuración vive en este repositorio ([`balanceador/templates/default.conf.template`](../balanceador/templates/default.conf.template))
y se despliega con [`scripts/balanceador.sh`](../scripts/balanceador.sh). No depende del reparto automático
de Azure: el algoritmo, la salud y la conmutación los define y versiona el equipo.

```mermaid
flowchart LR
    web["Navegador<br/>cafeorbe-web en Vercel"] -->|"HTTPS y WSS"| lb["cafeorbe-lb<br/>NGINX 1.27 · 2–4 réplicas"]
    subgraph rest["REST /"]
        a1["api-gateway (A)<br/>2–4 réplicas"]
        b1["api-gateway-b (B)<br/>2–4 réplicas"]
    end
    subgraph ws["WebSocket /ws/"]
        a2["realtime-gateway (A)<br/>4–6 réplicas"]
        b2["realtime-gateway-b (B)<br/>2–4 réplicas"]
    end
    lb -->|50 %| a1
    lb -->|50 %| b1
    lb -->|50 %| a2
    lb -->|50 %| b2
    a1 & b1 --> svc["identity · auction · wallet · streaming"]
    a2 & b2 --> rd[("Redis<br/>tickets, límites y difusión")]
    svc --> pg[("PostgreSQL")]
    svc --> mq{{"RabbitMQ"}}
    mq --> a2 & b2
```

## Qué hace

| Aspecto | Configuración |
|---|---|
| Rutas | `/ws/` → realtime-gateway A/B (WebSocket, 1 h de inactividad máxima) · todo lo demás → api-gateway A/B |
| Algoritmo | Reparto uniforme por petición: `split_clients` sobre `$request_id`, 50 % a cada instancia |
| Salud | Pasiva: 2 fallos de conexión en 15 s sacan a la instancia durante 15 s (`max_fails=2 fail_timeout=15s`) |
| Conmutación | Si la instancia elegida no responde (502/503), la petición pasa a la otra. Ante un tiempo agotado (504) solo se reintentan lecturas (GET, HEAD, OPTIONS), para no duplicar escrituras |
| Conexión a las instancias | HTTPS con SNI y `Host` de cada instancia; tiempo límite de conexión de 2 s |
| Trazabilidad | Cabecera `X-CafeOrbe-Instancia` (`api-a`, `api-b`, `realtime-a`, `realtime-b`) y log JSON por petición con instancia, estado, duración y `correlationId` |
| Seguridad | `X-Forwarded-For` conserva la IP del cliente (la usan las auditorías de SEG-01 a SEG-05); el log guarda la ruta sin la cadena de consulta, así que el ticket del WebSocket nunca queda registrado (SEG-04) |
| Sonda propia | `GET /lb/salud` → `UP` |

Las instancias A y B son Container Apps independientes con la misma imagen y configuración. Comparten Redis
(tickets de WebSocket, sesiones cerradas, límites de SEG-03 y difusión de eventos entre réplicas) y la cola de
RabbitMQ del realtime (consumidor único activo), así que un comprador puede caer en cualquiera de las dos.

## Desplegar en QA (Azure Cloud Shell)

```bash
cd ~/cafeorbe-infra && git pull
./scripts/balanceador.sh crear     # instancias B, imagen NGINX en ACR y Container App cafeorbe-lb
./scripts/balanceador.sh probar    # reparto A/B y ruta del WebSocket
```

Después, en Vercel (proyecto `cafeorbe-web` → Settings → Environment Variables), apuntar la web al balanceador
y volver a desplegar:

| Variable | Valor |
|---|---|
| `VITE_API_URL` | `https://<fqdn de cafeorbe-lb>` |
| `VITE_WS_URL` | `wss://<fqdn de cafeorbe-lb>` |

Los scripts de verificación usan `API_URL` y `WS_URL`; para medir a través del balanceador basta con exportar la
misma URL.

**Después de cada despliegue** de api-gateway o realtime-gateway (los pipelines solo actualizan la instancia A):

```bash
./scripts/balanceador.sh sincronizar
```

Para volver atrás: restaurar las variables de Vercel a las URL directas y `./scripts/balanceador.sh borrar`.

## Verificación local (17 nov 2026)

Imagen construida con Docker y ejecutada en local contra QA:

| Prueba | Resultado |
|---|---|
| `nginx -t` | Sintaxis correcta |
| 20 lecturas a `/actuator/health/readiness` | 10 a `api-a` y 10 a `api-b`, todas 200 |
| `GET /api/subastas` sin sesión | 401 del api-gateway (la petición llega al servicio) |
| Handshake de WebSocket sin ticket | 400 del realtime-gateway (la ruta `/ws/` llega al servicio) |
| Instancia B apagada: 12 lecturas | 12/12 respondidas por `api-a`, 0 errores |
| Instancia B apagada: 6 POST y 6 handshakes | Todos llegan al servicio por la instancia A, 0 errores del balanceador |

En la prueba local A y B apuntaban al mismo servicio de QA; la prueba en Azure, con instancias separadas, se
hace con `./scripts/balanceador.sh probar`.

## Despliegue en QA (17 nov 2026)

`./scripts/balanceador.sh crear` desde Azure Cloud Shell. Configuración resultante (`estado`):

| App | Imagen | CPU por réplica | Réplicas |
|---|---|---|---|
| `cafeorbe-lb` | `cafeorbe-lb:20261117T115540Z` | 0,25 | 2–4 |
| `api-gateway` (A) | `api-gateway:6f94fe1b` | 0,25 | 2–4 |
| `api-gateway-b` (B) | `api-gateway:6f94fe1b` | 0,25 | 2–4 |
| `realtime-gateway` (A) | `realtime-gateway:8872738c` | 0,5 | 4–6 |
| `realtime-gateway-b` (B) | `realtime-gateway:8872738c` | 0,5 | 2–4 |

URL del balanceador: `https://cafeorbe-lb.blackbay-48700ead.eastus2.azurecontainerapps.io`.
A y B ejecutan la misma imagen.

`./scripts/balanceador.sh probar`:

| Prueba | Resultado |
|---|---|
| 40 lecturas a `/actuator/health/readiness` | 40/40 con 200: 16 `api-a` y 24 `api-b` (reparto aleatorio por petición; con 40 muestras la diferencia es normal) |
| Handshake de WebSocket sin ticket | 400 del realtime-gateway (la ruta llega al servicio; no es un 5xx del balanceador) |

### Carga de REN-01 a través del balanceador y retiro (17 nov 2026)

Con la web apuntando al balanceador, una puja manual en dos pestañas se aceptó y el precio se actualizó en ambas.
La carga de 200 WebSockets de REN-01 (`carga-sala.mjs`, subasta de 3 min) **no llegó a medir**: abrió 163 de
200 conexiones. Las 75 primeras abrieron bien; entre la 75 y la 100 se perdieron 37 de golpe (5 abiertas se
cortaron con 1006 y las nuevas de ese momento no abrieron), y de la 100 a la 200 abrieron todas. No hubo
reinicios ni réplicas nuevas en `cafeorbe-lb`, `realtime-gateway` ni `realtime-gateway-b`.

**Causa sin confirmar.** Hipótesis por revisar en Log Analytics (estado de `/ws/` por instancia y errores de
NGINX entre 12:24 y 12:30 UTC): la conmutación de un handshake a la otra instancia reutiliza el ticket de un
solo uso que la primera ya consumió.

Por tiempo, antes de la presentación el equipo **retiró el balanceador**: se borraron `cafeorbe-lb`,
`api-gateway-b` y `realtime-gateway-b`, y la web volvió a las URL directas (comprobado en el build publicado
a las 12:38 UTC). Se vuelve a desplegar con `./scripts/balanceador.sh crear`.

## Límites conocidos

- NGINX de código abierto solo tiene salud pasiva: detecta una instancia caída por los fallos de las
  peticiones reales y no por sondas propias. La petición que descubre la falla se reenvía a la otra instancia.
- El reparto es por petición, no por usuario: un WebSocket queda en la instancia donde se abrió y, al
  reconectarse, puede caer en la otra. Funciona porque el estado compartido está en Redis.
- El balanceador corre como Container App, así que delante de él queda el ingreso de Azure (TLS público).
  El reparto entre instancias lo decide NGINX.
- Los pipelines no conocen las instancias B: hay que ejecutar `sincronizar` después de cada despliegue.
