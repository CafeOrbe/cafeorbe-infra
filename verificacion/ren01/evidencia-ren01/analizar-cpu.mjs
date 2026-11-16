const MINUTO = 60000;

/**
 * Minutos de Azure Monitor (PT1M; el timeStamp marca el inicio del minuto) que se cruzan con la ventana [inicio, fin).
 * Una ventana 13:28:02 a 13:38:02 toca 11 minutos: 13:28 a 13:38, incluido el último parcial. Si se tomaran solo 10
 * a partir del primero, un pico en 13:38 quedaría fuera y la corrida podría aprobar sin haberse medido completa.
 */
export function minutosDeLaVentana(inicioMs, finMs) {
  if (!Number.isFinite(inicioMs) || !Number.isFinite(finMs) || finMs <= inicioMs) return [];
  const primero = Math.floor(inicioMs / MINUTO);
  const ultimo = Math.ceil(finMs / MINUTO) - 1;
  return Array.from({ length: ultimo - primero + 1 }, (_, i) => primero + i);
}

/**
 * CPU de una réplica: exige un punto con Maximum en cada minuto que se cruza con la ventana y toma el máximo
 * solo de esos minutos. Sin cobertura completa no hay dictamen (cumple null), nunca un falso aprobado.
 */
export function evaluarCpuReplica(puntos, inicioMs, finMs, vcpu) {
  const minutos = minutosDeLaVentana(inicioMs, finMs);
  const queridos = new Set(minutos);
  const validos = (puntos || []).filter((p) => Number.isFinite(p?.maximum) && queridos.has(Math.floor(Date.parse(p.timeStamp) / MINUTO)));
  const vistos = new Set(validos.map((p) => Math.floor(Date.parse(p.timeStamp) / MINUTO)));
  const faltantes = minutos.filter((m) => !vistos.has(m)).map((m) => new Date(m * MINUTO).toISOString());
  const completa = minutos.length > 0 && faltantes.length === 0;
  const vcpuValida = Number.isFinite(vcpu) && vcpu > 0;
  const porcentajes = vcpuValida ? validos.map((p) => (p.maximum / (vcpu * 1e9)) * 100) : [];
  const maximo = porcentajes.length ? Math.max(...porcentajes) : null;
  return {
    cumple: completa && vcpuValida && maximo !== null ? maximo < 80 : null,
    maximoPorcentaje: maximo,
    minutosEsperados: minutos.length,
    minutosFaltantes: faltantes,
    coberturaCompleta: completa,
    puntos: validos.map((p, i) => ({ timestamp: p.timeStamp, porcentaje: porcentajes[i] ?? null })),
  };
}
