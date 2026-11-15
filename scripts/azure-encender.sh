#!/usr/bin/env bash
# ============================================================
# CaféOrbe · ENCENDER infraestructura Azure
# Uso: ./azure-encender.sh
# Inicia PostgreSQL. Los servicios críticos vuelven con 2 réplicas y
# los demás con 1; así el encendido conserva la topología de DIS-01.
# Todo vuelve a funcionar en ~2 minutos.
# ============================================================
set -euo pipefail

RG="cafeorbe-org"
APPS_BASE="identity-service wallet-service streaming-service"
APPS_CRITICAS="api-gateway auction-service realtime-gateway"

echo "☀️ Encendiendo infraestructura CaféOrbe..."

echo "→ Iniciando PostgreSQL..."
az postgres flexible-server start -n cafeorbe-pg -g "$RG"

echo "→ Escalando servicios base a 1 réplica..."
for app in $APPS_BASE; do
  echo "  · $app → 1 réplica"
  az containerapp update -n "$app" -g "$RG" --min-replicas 1 --max-replicas 2 --only-show-errors
done

echo "→ Escalando servicios críticos a 2–4 réplicas (DIS-01)..."
for app in $APPS_CRITICAS; do
  echo "  · $app → mínimo 2, máximo 4"
  az containerapp update -n "$app" -g "$RG" --min-replicas 2 --max-replicas 4 --only-show-errors
done

echo ""
echo "✅ Infraestructura encendida. Los servicios tardan ~60-90s en arrancar."
echo "   Verifica con: curl https://<fqdn>/actuator/health"
