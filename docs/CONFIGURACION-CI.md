# Configuración de los pipelines

Los seis servicios comparten la misma forma: `ci` → `build-push` → `deploy-qa`; `deploy-prod` solo se ejecuta con tags `v*`. `deploy-qa` falla antes de desplegar si falta la configuración marcada como obligatoria.

Cada repositorio documenta sus propios requisitos en `.github/workflows/README.md`.

## Secretos compartidos

| Nombre | Repos | Uso |
| --- | --- | --- |
| `AZURE_CREDENTIALS` | 6 servicios | `azure/login` |
| `ACR_USERNAME`, `ACR_PASSWORD` | 6 servicios | push a Azure Container Registry |
| `SONAR_TOKEN` | todos | Quality Gate; secreto de organización |
| `JWT_SECRET` | 6 servicios | firma y validación de la sesión; **mismo valor** |
| `INTERNAL_TOKEN` | 6 servicios | credencial interna SEG-02; **mismo valor en todos** |
| `DB_PASSWORD` | identity, auction, wallet, streaming | PostgreSQL |
| `RABBIT_PASSWORD` | identity, auction, wallet, streaming, realtime | CloudAMQP |
| `REDIS_PASSWORD` | api-gateway, identity, realtime | Azure Cache for Redis |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | streaming | LiveKit Cloud |
| `OTLP_METRICS_AUTH` | 6 servicios | métricas OTLP (opcional) |

`JWT_SECRET` e `INTERNAL_TOKEN` deben ser idénticos entre los repos que los usan. Si no coinciden, identity rechaza los tokens emitidos por otro servicio o los servicios rechazan las peticiones internas del gateway.

## Variables compartidas

| Nombre | Repos | Uso |
| --- | --- | --- |
| `ACR_NAME` | 6 servicios | registro de imágenes |
| `REDIS_HOST` | api-gateway, identity, realtime | host de Redis |
| `REDIS_PORT` (`6380`), `REDIS_SSL` (`true`) | api-gateway, identity, realtime | TLS |
| `GOOGLE_CLIENT_ID` | identity | audiencia del ID token de Google |
| `OTLP_METRICS_ENABLED`, `OTLP_METRICS_URL` | 6 servicios | métricas (opcional) |

## Redis

```bash
az redis create -n cafeorbe-redis -g cafeorbe-org --location eastus2 --sku Basic --vm-size c0
az redis show -n cafeorbe-redis -g cafeorbe-org --query hostName -o tsv
az redis list-keys -n cafeorbe-redis -g cafeorbe-org --query primaryKey -o tsv
```

`az redis list-keys` solo devuelve la clave definitiva cuando `provisioningState` es `Succeeded`; leerla durante `Creating` produce `WRONGPASS` en los servicios. Configurar `REDIS_HOST` como variable y `REDIS_PASSWORD` como secreto en `api-gateway`, `identity` y `realtime-gateway`.

## Google

1. Crear un OAuth client ID de tipo **Web application** en Google Cloud.
2. Añadir los orígenes exactos (`https://cafeorbe-web.vercel.app`, `http://localhost:5173`). No hacen falta redirect URIs.
3. Guardar el Client ID como variable `GOOGLE_CLIENT_ID` en `cafeorbe-identity-service` y como `VITE_GOOGLE_CLIENT_ID` en Vercel.
4. Volver a desplegar el frontend: Vite incrusta la variable en el bundle.

CaféOrbe no usa `client_secret`: identity valida la firma del ID token con las claves públicas de Google y comprueba la audiencia (`GOOGLE_CLIENT_ID`).

## Comprobación rápida

```bash
for app in api-gateway identity-service auction-service wallet-service streaming-service realtime-gateway; do
  curl -fsS "https://$app.blackbay-48700ead.eastus2.azurecontainerapps.io/actuator/health"
done
```
