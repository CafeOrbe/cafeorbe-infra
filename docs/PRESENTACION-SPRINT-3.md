# Sprint 3 · Texto para la presentación

## Disponibilidad

**Balanceador de carga.** Azure Load Balancer con dos VMs NGINX y sonda HTTP de salud cada 5 s. Si una VM cae, las conexiones nuevas pasan a la otra. En QA, la VM 2 atendió 30 de 30 lecturas con la VM 1 apagada.

**Escalado horizontal.** Auction y realtime operan con un mínimo de 4 réplicas y escalan hasta 6. En QA, la reconexión medida fue de 1,7 a 6,2 s. Pasaron 8 de 8 corridas con 4 réplicas.

**Demostración.** Ejecutar `./scripts/balanceador-azure.sh apagar-vm 1` y luego `./scripts/balanceador-azure.sh probar`. Encender de nuevo la VM 1 al terminar.

## Rendimiento

**QA.** Subasta de 3 minutos (2 min de carga sostenida), con 200 WebSockets y 20 pujas/s. Se enviaron 2.400 pujas, con p95 de 713 ms, p99 de 822 ms, 0 desconexiones y 0 duplicados. La certificación de 10 minutos registró p95 de 639 ms y CPU inferior al 80 %.

## Integración continua

**Quality Gate.** A en confiabilidad, seguridad y mantenibilidad. Cero bugs y cero vulnerabilidades nuevos. Duplicación inferior al 3 % y cobertura del código nuevo de al menos 80 %. Bono de cobertura entre 97 % y 99 % (97,8 % alcanzado).

## Observabilidad

**Tablero de negocio.** Actividad de subastas y pujas. **Tablero técnico.** Latencia, salud de réplicas y alerta «Réplica caída», con panel «Login p95 (SEG-01)» en tiempo real.

## Diagrama de despliegue

Vercel sirve la web. El navegador abre HTTPS y WSS contra Azure Load Balancer Standard. La sonda HTTP `/lb/salud` revisa ambas VMs NGINX. Cada VM termina TLS y reenvía REST al API Gateway y `/ws/` al Realtime Gateway de Azure Container Apps. Usar el [diagrama editable](07_despliegue.drawio).
