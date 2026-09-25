#!/usr/bin/env bash
# ============================================================
# CaféOrbe · ENCENDER infraestructura Azure
# Uso: ./azure-encender.sh
# Inicia PostgreSQL y escala las 6 container apps a 1 réplica.
# Todo vuelve a funcionar en ~2 minutos.
# ============================================================
set -euo pipefail

RG="cafeorbe-org"
APPS="identity-service auction-service wallet-service streaming-service realtime-gateway api-gateway"

echo "☀️ Encendiendo infraestructura CaféOrbe..."

echo "→ Iniciando PostgreSQL..."
az postgres flexible-server start -n cafeorbe-pg -g "$RG"

echo "→ Escalando container apps a 1 réplica..."
for app in $APPS; do
  echo "  · $app → 1 réplica"
  az containerapp update -n "$app" -g "$RG" --min-replicas 1 --only-show-errors
done

echo ""
echo "✅ Infraestructura encendida. Los servicios tardan ~60-90s en arrancar."
echo "   Verifica con: curl https://<fqdn>/actuator/health"