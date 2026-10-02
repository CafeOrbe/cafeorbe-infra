# cafeorbe-infra

> Todo lo que CaféOrbe necesita para ejecutarse y que no es código de negocio: el entorno local completo en Docker Compose, la topología de despliegue en la nube y los procedimientos de operación.

| | |
|---|---|
| **Responsabilidad** | Entorno local reproducible, dependencias de plataforma y guías de operación |
| **Tipo** | Infraestructura como código (Docker Compose) y scripts |
| **Componentes** | PostgreSQL 16 · RabbitMQ 3.13 · Redis 7 · LiveKit |
| **Ambientes** | Local (este repositorio) · QA y PROD en Azure Container Apps (pipelines de cada servicio) |

## Contenido

1. [Vista general del sistema](#1-vista-general-del-sistema)
2. [Entorno local](#2-entorno-local)
3. [Arranque](#3-arranque)
4. [Componentes de plataforma](#4-componentes-de-plataforma)
5. [Datos: una base por servicio](#5-datos-una-base-por-servicio)
6. [Configuración](#6-configuración)
7. [Despliegue en la nube](#7-despliegue-en-la-nube)
8. [Operación](#8-operación)
9. [Decisiones de arquitectura](#9-decisiones-de-arquitectura)
10. [Riesgos de despliegue](#10-riesgos-de-despliegue)

---

## 1. Vista general del sistema

```mermaid
flowchart TB
    web["cafeorbe-web<br/>navegador"]

    subgraph borde["Entrada"]
        gw["api-gateway :8080"]
        rt["realtime-gateway :8085"]
    end
    subgraph servicios["Servicios de negocio"]
        id["identity :8081"]
        au["auction :8082"]
        wa["wallet :8083"]
        st["streaming :8084"]
    end
    subgraph plataforma["Plataforma · este repositorio"]
        pg[("PostgreSQL<br/>4 bases")]
        mq{{"RabbitMQ"}}
        rd[("Redis")]
        lk["LiveKit"]
    end

    web -- "REST" --> gw
    web -- "WebSocket" --> rt
    web -. "video WebRTC" .-> lk
    gw --> id
    gw --> au
    gw --> wa
    gw --> st
    rt --> au
    au --> wa
    st --> au
    id --- pg
    au --- pg
    wa --- pg
    st --- pg
    id --> mq
    au --> mq
    st --> mq
    mq --> wa
    mq --> rt
    rt --- rd
    st --> lk
```

| Repositorio | Rol |
|---|---|
| `cafeorbe-web` | Cliente web |
| `cafeorbe-api-gateway` | Entrada REST: autenticación y enrutamiento |
| `cafeorbe-realtime-gateway` | Entrada WebSocket: salas en vivo |
| `cafeorbe-identity-service` | Sesión y token |
| `cafeorbe-auction-service` | Subastas y pujas |
| `cafeorbe-wallet-service` | Saldo de Orbes |
| `cafeorbe-streaming-service` | Señalización del video |
| `cafeorbe-contracts` | Contratos compartidos |
| `cafeorbe-infra` | Este repositorio |

## 2. Entorno local

`docker-compose.yml` define dos grupos. Las **dependencias** se levantan siempre; los **servicios** solo con el perfil `apps`.

```mermaid
flowchart LR
    subgraph siempre["docker compose up -d"]
        pg[("postgres<br/>:5432")]
        mq{{"rabbitmq<br/>:5672 · consola :15672"}}
        rd[("redis<br/>:6379")]
        lk["livekit<br/>:7880 · :7881 · :7882/udp"]
    end
    subgraph apps["perfil apps"]
        id["identity-service :8081"]
        au["auction-service :8082"]
        wa["wallet-service :8083"]
        st["streaming-service :8084"]
        rt["realtime-gateway :8085"]
        gw["api-gateway :8080"]
    end

    id --> pg
    au --> pg
    wa --> pg
    st --> pg
    id --> mq
    au --> mq
    wa --> mq
    st --> mq
    rt --> mq
    rt --> rd
    st --> lk
    lk -- "webhook por host.docker.internal:8084" --> st
    gw --> id
    gw --> au
    gw --> wa
    gw --> st
```

Esto permite dos formas de trabajo:

| Modo | Qué corre en Docker | Qué corre en la máquina | Cuándo |
|---|---|---|---|
| Desarrollo | Solo las dependencias | El servicio que se está tocando (`mvn spring-boot:run`) y el frontend | Día a día: recarga rápida y depuración |
| Todo en contenedores | Dependencias y los 6 servicios | Solo el frontend | Demos y pruebas de integración |

Los servicios esperan a que PostgreSQL y RabbitMQ estén **sanos** (healthchecks) antes de arrancar.

## 3. Arranque

Requisitos: Docker, **Java 21** (obligatorio: el build falla con otra versión) y Maven.

**Solo dependencias**

```bash
cp .env.example .env        # opcional: los valores por defecto sirven en local
docker compose up -d
```

Después, cada servicio desde su carpeta con `mvn spring-boot:run` y el frontend con `npm run dev`. Antes hay que ejecutar `mvn install` en `cafeorbe-contracts`.

**Todo en contenedores**

```powershell
.\scripts\build-all.ps1 -SkipTests            # instala contracts y empaqueta los 6 servicios
docker compose --profile apps up -d --build
```

El orden del script es obligatorio: `cafeorbe-contracts` primero, porque los servicios dependen de él. Las imágenes copian el jar ya empaquetado; no compilan dentro del contenedor.

**Detener**

```bash
docker compose --profile apps stop      # conserva los datos
docker compose --profile apps down -v   # borra también los volúmenes
```

## 4. Componentes de plataforma

| Componente | Puerto | Para qué | Quién lo usa |
|---|---|---|---|
| PostgreSQL 16 | `5432` | Persistencia, una base por servicio | identity, auction, wallet, streaming |
| RabbitMQ 3.13 | `5672` · consola `15672` | Eventos entre servicios. Exchange topic `cafeorbe.eventos` | Todos menos el api-gateway |
| Redis 7 | `6379` | Presencia y difusión entre instancias del realtime-gateway | realtime-gateway |
| LiveKit | `7880` · `7881` · `7882/udp` | Servidor de medios WebRTC para el video en vivo | streaming-service y el navegador |

**LiveKit en local.** `livekit/livekit.yaml` define la clave de desarrollo y el webhook hacia el streaming-service. El webhook apunta a `host.docker.internal:8084`, así funciona igual si streaming corre en un contenedor o directamente en la máquina, porque el puerto 8084 está publicado en ambos casos.

## 5. Datos: una base por servicio

```mermaid
flowchart LR
    subgraph pg["Una instancia de PostgreSQL"]
        d1[("identity_db<br/>usuario identity")]
        d2[("auction_db<br/>usuario auction")]
        d3[("wallet_db<br/>usuario wallet")]
        d4[("streaming_db<br/>usuario streaming")]
    end
    id["identity-service"] --> d1
    au["auction-service"] --> d2
    wa["wallet-service"] --> d3
    st["streaming-service"] --> d4
```

- `postgres/01-bases-de-datos.sql` crea, la primera vez, cuatro bases y cuatro usuarios, y **revoca el acceso público**: cada usuario solo puede conectarse a su propia base.
- Es una sola instancia por economía, pero el aislamiento es real: ningún servicio puede leer los datos de otro. Separarlas en instancias distintas no exigiría cambiar código.
- Las tablas no se crean aquí. Cada servicio trae sus migraciones (Flyway) y las aplica al arrancar.
- El script solo se ejecuta cuando el volumen de PostgreSQL está vacío.

## 6. Configuración

Todos los valores tienen un valor por defecto para desarrollo. `.env.example` lista los que se pueden cambiar; `.env` no se versiona.

| Variable | Usada por | Descripción |
|---|---|---|
| `JWT_SECRET` | identity, api-gateway, realtime-gateway | Secreto para firmar y validar el token de sesión (mínimo 32 caracteres) |
| `DB_URL` `DB_USER` `DB_PASSWORD` | identity, auction, wallet, streaming | Conexión a su base |
| `RABBIT_HOST` `RABBIT_PORT` `RABBIT_USER` `RABBIT_PASSWORD` | Todos menos el api-gateway | Broker |
| `REDIS_HOST` | realtime-gateway | Presencia y backplane |
| `IDENTITY_URL` `AUCTION_URL` `WALLET_URL` `STREAMING_URL` | api-gateway | Destino de cada grupo de rutas |
| `AUCTION_URL` | realtime-gateway, streaming | Reenvío de pujas; verificación de dueño y estado |
| `WALLET_URL` | auction | Consulta síncrona de saldo |
| `LIVEKIT_URL` | streaming | URL de LiveKit que usa el **navegador** |
| `LIVEKIT_API_URL` | streaming | URL de la API de LiveKit vista **desde el servicio** |
| `LIVEKIT_API_KEY` `LIVEKIT_API_SECRET` | streaming | Firma de credenciales de video y verificación de webhooks |
| `CORS_ORIGINS` | api-gateway, realtime-gateway | Orígenes permitidos del frontend |
| `WALLET_SALDO_INICIAL` | wallet | Orbes de la carga automática |

Los secretos de este repositorio son **solo para desarrollo local** y están marcados para cambiarse en producción.

## 7. Despliegue en la nube

Este repositorio no despliega. Cada servicio tiene su propio pipeline (`.github/workflows/ci.yml` en su repositorio), todos con la misma forma.

```mermaid
flowchart LR
    A["push a main<br/>o pull request"] --> B["CI<br/>compila contracts y ejecuta mvn verify"]
    B --> C["Imagen Docker<br/>Azure Container Registry"]
    C --> D["QA<br/>Azure Container Apps"]
    D --> E["Prueba de humo<br/>/actuator/health"]
    T["etiqueta v*"] --> B
    C --> P["PROD<br/>Azure Container Apps"]
```

**Topología en Azure**, según los pipelines y `docs/APAGADO-AZURE.md`:

```mermaid
flowchart TB
    U["Usuario"]
    V["Vercel<br/>cafeorbe-web"]
    subgraph aca["Azure Container Apps · ambiente QA"]
        gw["api-gateway"]
        rt["realtime-gateway"]
        id["identity-service"]
        au["auction-service"]
        wa["wallet-service"]
        st["streaming-service"]
    end
    pg[("Azure PostgreSQL<br/>4 bases")]
    rd[("Azure Cache for Redis")]
    mq{{"CloudAMQP<br/>RabbitMQ gestionado"}}
    lk["LiveKit Cloud"]
    acr["Azure Container Registry"]

    U --> V
    V -- "REST" --> gw
    V -- "WebSocket" --> rt
    gw --> id
    gw --> au
    gw --> wa
    gw --> st
    id --- pg
    au --- pg
    wa --- pg
    st --- pg
    rt --- rd
    id --> mq
    au --> mq
    st --> mq
    mq --> wa
    mq --> rt
    st --> lk
    acr -. "imágenes" .-> aca
```

| Pieza | Local | Nube |
|---|---|---|
| Frontend | Vite en `:5173` | Vercel |
| Servicios | Contenedores o `mvn spring-boot:run` | Azure Container Apps |
| Base de datos | Contenedor PostgreSQL | Azure Database for PostgreSQL |
| Broker | Contenedor RabbitMQ | CloudAMQP |
| Redis | Contenedor Redis | Azure Cache for Redis |
| Video | Contenedor LiveKit | LiveKit Cloud |
| Imágenes | Build local | Azure Container Registry |

## 8. Operación

| Tarea | Cómo |
|---|---|
| Ver el estado de un servicio | `GET /actuator/health` en su puerto |
| Ver los eventos y las colas | Consola de RabbitMQ en `http://localhost:15672` |
| Ver los registros de un servicio | `docker compose logs -f auction-service` |
| Reiniciar con datos limpios | `docker compose --profile apps down -v` y volver a levantar |
| Apagar y encender la nube para ahorrar crédito | Ver `docs/APAGADO-AZURE.md` y la nota de abajo |

**Antes de una demo en la nube:** encender la infraestructura con tiempo. Con la nube apagada, las direcciones públicas responden `502` y el frontend publicado no puede iniciar sesión.

**Encender y apagar las aplicaciones.** Primero PostgreSQL y después las aplicaciones. Redis y el registro de imágenes no se pueden apagar. Las aplicaciones detenidas con Stop no se recuperan cambiando las réplicas mínimas; hay que arrancarlas. Lo mismo sirve para reiniciar una aplicación después de cambiarle la configuración: detenerla y arrancarla. Desde Cloud Shell (la CLI reemplaza sola `{subscriptionId}`):

```bash
az postgres flexible-server start -n cafeorbe-pg -g cafeorbe-org

for app in identity-service wallet-service auction-service streaming-service realtime-gateway api-gateway; do
  az rest --method post --url "https://management.azure.com/subscriptions/{subscriptionId}/resourceGroups/cafeorbe-org/providers/Microsoft.App/containerApps/$app/start?api-version=2024-03-01"
done
```

Para apagar: la misma llamada con `stop` en lugar de `start`, y al final `az postgres flexible-server stop -n cafeorbe-pg -g cafeorbe-org`.

## 9. Decisiones de arquitectura

| Decisión | Motivo | Costo aceptado |
|---|---|---|
| Un repositorio por servicio y uno de infraestructura | Cada servicio se compila, versiona y despliega por separado | Levantar todo exige clonar nueve repositorios en la misma carpeta |
| Perfil `apps` separado de las dependencias | El desarrollador levanta solo lo que no está tocando | Dos formas de arrancar que mantener |
| Una instancia de PostgreSQL con cuatro bases aisladas | Aislamiento de datos sin el costo de cuatro servidores | Un solo punto de falla para la persistencia |
| Las imágenes copian un jar ya empaquetado | Builds de imagen rápidos y Dockerfiles mínimos | Hay que empaquetar antes de construir la imagen |
| Servicios gestionados en la nube (PostgreSQL, Redis, RabbitMQ, video) | El equipo no opera bases ni brokers | Costo mensual y dependencia de proveedores |
| Contenedores sin servidor (Container Apps) | Escalado a cero cuando no se usa: clave con crédito limitado | Arranque en frío de 60 a 90 segundos |
| QA con cada cambio en `main`, PROD por etiqueta | Entrega continua a QA; el paso a PROD es una decisión explícita | Requiere disciplina de etiquetado |

## 10. Riesgos de despliegue

Revisión hecha el 2026-10-01 sobre los pipelines, el código y el estado real de Azure: configuración consultada con la CLI, cambios aplicados a mano en QA y la verificación de extremo a extremo `CafeOrbe_Contexto/verificacion/e2e-sprint1.mjs` ejecutada contra QA.

**Un dato que condiciona todo lo demás:** el ambiente de QA es de tipo **express**. En ese tipo de ambiente no existen nombres `.internal.`, el ingress interno no aísla a la aplicación y un cambio de configuración no reinicia la réplica.

| # | Riesgo | Estado | Evidencia | Acción |
|:-:|---|---|---|---|
| 1 | En QA no se podía iniciar sesión ni usar nada a través del api-gateway | **Corregido y verificado en Azure** | El gateway y tres servicios buscaban a los demás por nombres `.internal.`, que no existen: Azure respondía `404`. Con el nombre real de cada aplicación por `https`, la verificación de extremo a extremo pasa 70 de 70 en QA, también después de desplegar desde `main`. Justo tras un despliegue, la primera puja tarda algo más de 1 s por el arranque en frío; después, entre 0,5 y 0,8 s | Los pipelines usan ya los nombres reales |
| 2 | Un cambio de configuración no reinicia la aplicación | **Verificado en Azure** | Tras `az containerapp update --set-env-vars`, la réplica siguió corriendo con los valores anteriores hasta detener y arrancar la aplicación | Un despliegue con imagen nueva sí reemplaza la réplica (comprobado). Tras cambiar solo variables a mano, detener y arrancar la aplicación |
| 3 | Los servicios internos están publicados en internet, aunque confían en las cabeceras `X-User-*` | **Verificado en Azure. Abierto** | Los seis responden en su dirección pública. Al pedir ingress interno, Azure guarda el valor pero la aplicación sigue siendo pública; permitir `http` interno se rechaza por no estar soportado en express | Secreto compartido entre el api-gateway y los servicios, o pasar a un ambiente con red propia |
| 4 | Las pruebas de humo no detectaban un sistema roto | **Corregido y verificado en Azure** | Solo consultaban `/actuator/health`: pasaban aunque no se pudiera iniciar sesión | En identity, auction, wallet y streaming la prueba de humo hace una petición real a través del api-gateway. Pasó en los cuatro despliegues a QA |
| 5 | `LIVEKIT_API_URL` no estaba definida en la nube | **Verificado en Azure. Corregido en el código** | La variable no existía y el valor por defecto era `localhost`: cerrar salas y expulsar participantes fallaba en silencio | Si no se indica, se deduce de `LIVEKIT_URL` (`wss` → `https`) |
| 6 | El webhook de LiveKit solo se podía recibir llamando directo a streaming | **Corregido en el código.** Falta configurarlo en LiveKit | El api-gateway deja pasar sin token `POST /api/streaming/webhooks/livekit`; streaming lo autentica por la firma de LiveKit | Registrar en el proyecto de LiveKit Cloud la URL `https://<api-gateway>/api/streaming/webhooks/livekit` y probar cerrando la pestaña del Subastador |
| 7 | Los scripts de apagado y encendido no reflejan cómo se apaga realmente | **Verificado en Azure** | Las aplicaciones se detienen con Stop, y `azure-encender.sh` solo cambia las réplicas mínimas: no las vuelve a arrancar. `az containerapp start` no existe en la CLI de Cloud Shell | Arrancar y detener con la API de administración (sección 8) y actualizar los scripts |
| 8 | QA y PROD usan la misma base de datos, el mismo broker y el mismo Redis | **Verificado en Azure.** Aún no ocurre: PROD nunca se ha desplegado | Existen los dos ambientes, pero un solo PostgreSQL y un solo Redis. Ningún repositorio tiene etiquetas `v*` | Bases, vhost y Redis propios para PROD antes de crear la primera etiqueta |
| 9 | Las URLs de PROD apuntaban a aplicaciones que no existirían | **Corregido en los pipelines; sin probar** | Usaban `.internal.` y el nombre sin el sufijo `-prod` con el que el pipeline crea las aplicaciones | Verificar en el primer despliegue a PROD |
| 10 | El api-gateway no valida el certificado de los servicios | **Verificado en el código** | `use-insecure-trust-manager: true`. Ya no debería hacer falta: los nombres reales tienen certificado válido, y auction ya llama a wallet por `https` validándolo | Quitar la opción y probar en QA |
| 11 | Redis sin TLS | **Verificado en Azure** | El puerto sin TLS está habilitado y el realtime-gateway se conecta por `6379`: la contraseña viaja sin cifrar | Puerto TLS `6380` |
| 12 | Un solo usuario de base de datos para los cuatro servicios | **Verificado en Azure** | Los cuatro usan el mismo usuario; el aislamiento por base del entorno local se pierde | Un usuario por servicio, como en local |
| 13 | Secretos como variables de entorno en texto plano | **Verificado en Azure** | Ninguna contraseña usa una referencia a secreto | Secretos de Container Apps con referencia desde la variable |
| 14 | El frontend publicado no resolvía rutas internas | **Corregido y verificado** | Abrir o recargar `/login` o `/comprador` respondía `404` | `vercel.json` con la reescritura hacia `index.html`, ya publicado |
| 15 | Imagen de LiveKit sin versión fija en local | **Verificado** | `livekit/livekit-server:latest` | Fijar una versión |
| 16 | Los servicios compilan contra el último commit de `cafeorbe-contracts` | **Verificado en los pipelines** | Cada pipeline clona y compila `main` de contracts | Versiones publicadas y fijas |
