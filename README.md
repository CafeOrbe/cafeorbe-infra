# cafeorbe-infra

Infraestructura local de CaféOrbe: `docker-compose`, una base de datos por servicio, broker, Redis y proveedor de video.

## Arranque rápido (desarrollo)

```bash
cp .env.example .env                 # opcional: los valores por defecto ya sirven en local
docker compose up -d                 # RabbitMQ, Postgres, Redis y LiveKit
```

Luego, cada servicio se levanta desde su carpeta con `mvn spring-boot:run` y el frontend con `npm run dev`
(ver el README de cada repositorio). Antes hay que ejecutar `mvn install` en `cafeorbe-contracts`.

## Todo en contenedores

```powershell
.\scripts\build-all.ps1 -SkipTests   # mvn install de contracts + mvn package de los 6 servicios
docker compose --profile apps up -d --build
```

## Qué levanta

| Servicio | Puerto | Notas |
|---|---|---|
| PostgreSQL 16 | 5432 | Bases `identity_db`, `auction_db`, `wallet_db`, `streaming_db`, cada una con su usuario (mismo nombre y contraseña que el servicio; solo dev). |
| RabbitMQ 3.13 | 5672 · 15672 | Consola en http://localhost:15672 (`cafeorbe` / `cafeorbe`). Exchange `cafeorbe.eventos` (topic). |
| Redis 7 | 6379 | Backplane pub/sub y presencia del realtime-gateway. |
| LiveKit | 7880 · 7881 · 7882/udp | Proveedor de video WebRTC. Clave de desarrollo en `livekit/livekit.yaml`. |

## Puertos de los servicios (perfil `apps` o ejecución local)

`8080` api-gateway · `8081` identity · `8082` auction · `8083` wallet · `8084` streaming · `8085` realtime-gateway · `5173` web

## Variables de entorno comunes

| Variable | Usada por | Descripción |
|---|---|---|
| `JWT_SECRET` | gateway, identity, realtime | Secreto HS256 (≥ 32 caracteres) para el token de sesión. |
| `DB_URL` `DB_USER` `DB_PASSWORD` | identity, auction, wallet, streaming | Conexión a su base. |
| `RABBIT_HOST` `RABBIT_PORT` `RABBIT_USER` `RABBIT_PASSWORD` | todos menos el gateway | Broker. |
| `WALLET_URL` | auction | Consulta síncrona de saldo (HU-14). |
| `AUCTION_URL` | gateway, realtime | Destino de las pujas y de las rutas `/api/subastas`. |
| `LIVEKIT_URL` `LIVEKIT_API_KEY` `LIVEKIT_API_SECRET` | streaming | Proveedor de video. |
| `LIVEKIT_API_URL` | streaming | API de servidor de LiveKit vista desde el servicio (cerrar salas, expulsar). |
| `AUCTION_URL` | streaming | Para verificar el dueño y el estado de la subasta antes de transmitir. |
| `WALLET_SALDO_INICIAL` | wallet | Orbes de la carga automática (HU-07). |

## Limpieza del MVP

Según `ARQUITECTURA_CafeOrbe_MVP.md`, aquí no debe haber contenedores, bases ni variables de `store-service` ni de `shipping-service`.
