export function analizar(m, pgFinal) {
  const criterios = [];
  const add = (criterio, cumple, observado) => criterios.push({criterio,cumple,observado});
  const events = m.eventos?.aceptadosPorSocket || [];
  const attempts = m.pujas?.intentos || [];
  const lat = m.latenciasMs || [];
  add('Instrumentacion completa', m.versionMedicion === 2 && !m.errorEjecucion && Number.isFinite(m.ventana?.duracionRealMs) && !!m.estadoFinal, m.errorEjecucion || m.versionMedicion);
  add('200 WS durante toda la carga', m.configuracion.usuarios === 200 && m.conexiones.minimoDuranteCarga === 200 && m.conexiones.finalesActivas === 200 && events.length === 200, m.conexiones);
  add('600 s sostenidos', m.configuracion.duracionSegundos === 600 && m.ventana?.duracionRealMs >= 600000, m.ventana);
  const bins = Array.from({length:60}, (_, i) => Array.from({length:10},(_,j)=>m.enviosPorSegundo?.[i*10+j] || 0).reduce((a,b)=>a+b,0));
  // Carga completa: exactamente los 12.000 envíos programados, ninguno sin emisor, y cada bloque de 10 s con sus 200.
  const gen = m.generador;
  add('20 pujas/s sostenidas (bloques de 10 s)', m.configuracion.tasaObjetivo === 20 && m.pujas.enviadas === 12000 && bins.every(n=>n>=200)
    && !!gen && gen.totalProgramados === 12000 && gen.sinEmisor === 0, {enviadas:m.pujas.enviadas,bloques10s:bins,generador:gen ?? 'sin datos del generador'});
  add('p95 a todos <=800 ms', lat.length > 0 && m.resumenLatencia.p95 <= 800, m.resumenLatencia.p95);
  add('p99 a todos <=1500 ms', lat.length > 0 && m.resumenLatencia.p99 <= 1500, m.resumenLatencia.p99);
  add('0 caidas y errores', m.conexiones.desconexiones === 0 && m.conexiones.erroresConexion === 0 && m.pujas.erroresHttpOTransporte === 0 && m.eventos.erroresAplicacion === 0 && m.eventos.mensajesInvalidos === 0, {conexiones:m.conexiones,transporte:m.pujas.erroresHttpOTransporte,aplicacion:m.eventos.erroresAplicacion});
  add('0 duplicados/desorden/gaps observados', m.eventos.duplicados === 0 && m.eventos.fueraDeOrden === 0 && m.eventos.perdidosGaps === 0, {duplicados:m.eventos.duplicados,desorden:m.eventos.fueraDeOrden,gaps:m.eventos.perdidosGaps});
  add('Todos los intentos reconciliados', m.pujas.pendientes === 0 && m.pujas.respuestasNoCorrelacionadas === 0 && attempts.length === m.pujas.enviadas && attempts.every(a=>a.estado === 'aceptada' || a.estado === 'rechazada') && m.pujas.aceptadas + m.pujas.rechazadas === m.pujas.enviadas, {pendientes:m.pujas.pendientes,noCorrelacionadas:m.pujas.respuestasNoCorrelacionadas});
  const delta = m.estadoFinal?.cantidadPujas - m.baseline?.cantidadPujas;
  const rows = pgFinal?.pujas?.filter(p=>p.monto > m.baseline?.precioActual) || [];
  const unique = new Set(rows.map(p=>p.monto));
  add('1 fila ganadora por incremento en PostgreSQL', !!pgFinal && !pgFinal.error && delta > 0 && rows.length === delta && unique.size === rows.length && pgFinal.subasta.cantidadPujas === m.estadoFinal.cantidadPujas && m.pujas.aceptadas === delta, {delta,filas:rows.length,montosUnicos:unique.size});
  let completas = 0;
  const winners = new Set(rows.map(p=>`${p.monto}:${p.usuarioId}`));
  const missing = [];
  for(let i=0;i<events.length;i++) {
    const socket = events[i];
    const valid = socket.length === delta && socket.every((e,j)=>e.cantidad === m.baseline.cantidadPujas+j+1 && winners.has(`${e.monto}:${e.usuarioId}`) && Number.isFinite(e.latenciaMs));
    if(valid) completas++; else missing.push(i);
  }
  add('Entrega completa a los 200, incluidos primer/ultimo evento', completas === 200 && lat.length === delta*200 && attempts.filter(a=>a.estado==='aceptada').every(a=>a.receptores===200), {completas,delta,muestras:lat.length,socketsIncompletos:missing});
  return criterios;
}
