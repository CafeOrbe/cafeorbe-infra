# CaféOrbe · Gestión de infraestructura Azure

> Guía para el equipo: cómo apagar y encender la infraestructura para **ahorrar crédito** de Azure for Students cuando no estemos trabajando.

---

## 📦 ¿Qué tenemos desplegado en Azure?

| Recurso | Nombre | Función | Costo aprox./mes |
|---|---|---|---|
| Container Apps × 6 | `identity-service`, `auction-service`, `wallet-service`, `streaming-service`, `realtime-gateway`, `api-gateway` | Los 6 servicios backend | ~$10-20 |
| PostgreSQL Flexible | `cafeorbe-pg` | 4 bases de datos (identity, auction, wallet, streaming) | ~$15 |
| Azure Cache for Redis | `cafeorbe-redis` | Backplane del realtime-gateway | ~$15 |
| Azure Container Registry | `cafeorbeacr` | Imágenes Docker de los servicios | ~$5 |
| Log Analytics | `cafeorbe-logs` | Logs de los servicios | ~$2 |
| **Total** | | | **~$45-55/mes** |

> 💰 **Crédito Azure for Students:** $100/mes. Con todo encendido gastamos ~50% del crédito. Apagando cuando no trabajamos, el gasto baja a ~$20/mes (solo Redis + ACR + storage).

---

## 🌙 APAGAR (cuando no estemos trabajando)

Ejecuta el script:

```bash
cd cafeorbe-infra/scripts
./azure-apagar.sh
```

**Qué hace:**

| Paso | Comando | Efecto |
|---|---|---|
| 1 | `az postgres flexible-server stop` | Detiene Postgres — **los datos se conservan**, solo deja de cobrar el compute |
| 2 | `az containerapp update --min-replicas 0` × 6 | Las 6 apps escalan a 0 réplicas — **dejan de cobrar** |

**Ahorro:** ~$25-35/mes mientras esté apagado.

---

## ☀️ ENCENDER (cuando retomemos)

```bash
cd cafeorbe-infra/scripts
./azure-encender.sh
```

**Qué hace:**

| Paso | Comando | Efecto |
|---|---|---|
| 1 | `az postgres flexible-server start` | Inicia Postgres |
| 2 | `az containerapp update --min-replicas 1` × 6 | Las apps vuelven a 1 réplica |

**Tiempo de recuperación:** ~2 minutos (los servicios Spring Boot tardan 60-90s en arrancar).

---

## 📊 Qué se apaga y qué no

| Recurso | ¿Se apaga? | Costo cuando está apagado | Nota |
|---|---|---|---|
| PostgreSQL | ✅ Sí | ~$2 (solo storage) | Datos intactos |
| 6 Container Apps | ✅ Sí | $0 | Escalan a 0 |
| Redis | ❌ No tiene stop | ~$15/mes fijo | Opción: eliminar y recrear (es solo cache) |
| ACR | ❌ No se apaga | ~$5/mes fijo | Necesario para los deploys |
| CloudAMQP | ❌ Gratis | $0 | Broker de mensajes (free tier) |
| Log Analytics | ❌ Mínimo | ~$2 | Útil para debug |

---

## ⚠️ Advertencias importantes

1. **No pushear con Postgres apagado.** Si hacemos `git push` a `main` mientras Postgres está detenido, el workflow de CI/CD correrá pero el **smoke test fallará** (el health estará DOWN porque la DB no responde). El deploy funciona — solo el smoke test se pone rojo. **Siempre encender Postgres antes de pushear.**

2. **Redis no se apaga.** Si queremos ahorrar sus ~$15/mes, hay que eliminarlo y recrearlo cuando se necesite (pierde la cache, se recrea en ~2 min):
   ```bash
   # Eliminar (cuando apaguemos todo)
   az redis delete -n cafeorbe-redis -g cafeorbe-org --yes
   # Recrear (cuando encendamos)
   az redis create -n cafeorbe-redis -g cafeorbe-org --sku Basic --vm-size c0
   az redis update -n cafeorbe-redis -g cafeorbe-org --enable-non-ssl-port true
   ```

3. **Los deploys reactivan las apps.** Si alguien hace push a `main`, el workflow despliega con `--min-replicas 1` — la app se enciende sola aunque la hayamos apagado. Para mantener todo apagado, no pushear (o apagar después del deploy).

---

## 🧠 Resumen rápido

| Situación | Acción |
|---|---|
| "Terminé por hoy" | `./azure-apagar.sh` |
| "Vuelvo a trabajar" | `./azure-encender.sh` |
| "Voy a pushear" | Primero `./azure-encender.sh` (Postgres debe estar arriba) |
| "Quiero ahorrar más" | Eliminar Redis también (ver advertencia 2) |

---

## 🔍 Verificación rápida

Después de encender, verifica que un servicio responde:

```bash
# Obtén el FQDN de un servicio
az containerapp show -n identity-service -g cafeorbe-org \
  --query properties.configuration.ingress.fqdn -o tsv

# Health check (debe responder {"status":"UP"})
curl https://<fqdn>/actuator/health
```

---

*Documento generado para el equipo CaféOrbe · ARSW · 2026*