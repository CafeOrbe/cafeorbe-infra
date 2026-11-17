#!/usr/bin/env bash
# ============================================================
# CaféOrbe · ENCENDER infraestructura Azure
# Uso: ./azure-encender.sh
# Inicia PostgreSQL. Auction y realtime vuelven con 4–6 réplicas,
# api-gateway con 2–4 y los demás con 1–2 (topología DIS-01).
# Todo vuelve a funcionar en ~2 minutos.
# ============================================================
set -euo pipefail

RG="cafeorbe-org"
APPS_BASE="identity-service wallet-service streaming-service"
APPS_DIS01="auction-service realtime-gateway"

echo "☀️ Encendiendo infraestructura CaféOrbe..."

echo "→ Iniciando PostgreSQL..."
az postgres flexible-server start -n cafeorbe-pg -g "$RG"

echo "→ Escalando servicios base a 1 réplica..."
for app in $APPS_BASE; do
  echo "  · $app → 1 réplica"
  az containerapp update -n "$app" -g "$RG" --min-replicas 1 --max-replicas 2 --only-show-errors
done

echo "→ api-gateway: mínimo 2, máximo 4"
az containerapp update -n api-gateway -g "$RG" --min-replicas 2 --max-replicas 4 --only-show-errors

echo "→ Auction y realtime: 0,5 vCPU / 1 GiB, mínimo 4, máximo 6 (DIS-01)..."
for app in $APPS_DIS01; do
  echo "  · $app → mínimo 4, máximo 6"
  opciones_pool=()
  if [[ "$app" == auction-service ]]; then opciones_pool=(--set-env-vars DB_POOL_MAX=2); fi
  az containerapp update -n "$app" -g "$RG" --cpu 0.5 --memory 1Gi --min-replicas 4 --max-replicas 6 "${opciones_pool[@]}" --only-show-errors
done

echo ""
echo "✅ Infraestructura encendida. Los servicios tardan ~60-90s en arrancar."
echo "   Verifica con: curl https://<fqdn>/actuator/health"
