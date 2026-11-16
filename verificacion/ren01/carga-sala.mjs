/**
 * CaféOrbe · REN-01 Script de Carga de Sala
 * Escenario: 200 compradores WebSocket, hasta 20 pujas/s sostenidas.
 * Medición: Latencia punta a punta, p95, p99, secuencias, duplicados y eventos perdidos.
 */

import { readFileSync, writeFileSync } from 'fs';
import { performance } from 'perf_hooks';

// Argumentos CLI
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    subastaId: '79ff79c1-195f-4864-8f32-165e701ba84c',
    usuarios: 200,
    tasa: 20, // pujas por segundo
    duracion: 600, // segundos
    rampup: 20, // segundos para conectar usuarios
    etapa: 'objetivo',
    salida: 'resultado-carga.json',
    html: 'resultado-carga.html',
    apiBase: 'https://api-gateway.blackbay-48700ead.eastus2.azurecontainerapps.io',
    wsBase: 'wss://realtime-gateway.blackbay-48700ead.eastus2.azurecontainerapps.io'
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--subasta': options.subastaId = args[++i]; break;
      case '--usuarios': options.usuarios = parseInt(args[++i], 10); break;
      case '--tasa': options.tasa = parseFloat(args[++i]); break;
      case '--duracion': options.duracion = parseInt(args[++i], 10); break;
      case '--rampup': options.rampup = parseInt(args[++i], 10); break;
      case '--etapa': options.etapa = args[++i]; break;
      case '--salida': options.salida = args[++i]; break;
      case '--html': options.html = args[++i]; break;
      case '--api': options.apiBase = args[++i]; break;
      case '--ws': options.wsBase = args[++i]; break;
    }
  }
  return options;
}

const opts = parseArgs();
console.log(`\n======================================================`);
console.log(`  CaféOrbe · Carga de Sala [Etapa: ${opts.etapa.toUpperCase()}]`);
console.log(`  Subasta:  ${opts.subastaId}`);
console.log(`  Usuarios: ${opts.usuarios} conexiones WebSocket`);
console.log(`  Ritmo:    ${opts.tasa} pujas/s`);
console.log(`  Duración: ${opts.duracion} s (${(opts.duracion / 60).toFixed(1)} min)`);
console.log(`======================================================\n`);

const todosCompradores = JSON.parse(readFileSync('compradores.json', 'utf-8'));
if (todosCompradores.length < opts.usuarios) {
  console.error(`Error: se requieren ${opts.usuarios} usuarios pero sólo hay ${todosCompradores.length} en compradores.json`);
  process.exit(1);
}
const compradores = todosCompradores.slice(0, opts.usuarios);

// Estructura de métricas
const metricas = {
  etapa: opts.etapa,
  subastaId: opts.subastaId,
  configuracion: {
    usuarios: opts.usuarios,
    tasaObjetivo: opts.tasa,
    duracionSegundos: opts.duracion,
    rampupSegundos: opts.rampup
  },
  conexiones: {
    abiertasExitosas: 0,
    desconexiones: 0,
    erroresConexion: 0,
    picoConexionesActivas: 0,
    finalesActivas: 0
  },
  pujas: {
    enviadas: 0,
    aceptadas: 0,
    rechazadas: 0,
    erroresHttpOTransporte: 0,
    pujasPorSegundoEfectivas: 0
  },
  eventos: {
    totalRecibidos: 0,
    pujaAceptadaRecibidos: 0,
    duplicados: 0,
    fueraDeOrden: 0,
    perdidosGaps: 0
  },
  latenciasMs: [],
  resumenLatencia: {
    p50: 0,
    p90: 0,
    p95: 0,
    p99: 0,
    min: 0,
    max: 0,
    promedio: 0
  },
  inicioIso: new Date().toISOString(),
  finIso: null
};

// Mapa de conexiones activas
const sockets = [];
// Mapa de pujas pendientes de confirmación: monto -> { t0, correlationId, usuarioId }
const pujasEnVuelo = new Map();
// Conservar el origen hasta que TODOS los sockets reciban el evento aceptado.
const enviosFormales = new Map();
let midiendo = false;
let cierreIntencional = false;
metricas.versionMedicion = 2;
metricas.ventana = { inicioIso: null, finIso: null, duracionRealMs: null };
metricas.enviosPorSegundo = [];
metricas.conexiones.minimoDuranteCarga = null;
metricas.eventos.aceptadosPorSocket = Array.from({length: opts.usuarios}, () => []);
metricas.eventos.erroresAplicacion = 0;
metricas.eventos.mensajesInvalidos = 0;
metricas.pujas.respuestasNoCorrelacionadas = 0;

// Control de secuencia por socket: socketIndex -> lastSecuencia
const secuenciasPorSocket = new Array(opts.usuarios).fill(-1);
// Control de cantidad de pujas por subasta (estrictamente consecutiva 1, 2, 3...)
const cantidadesPujasPorSocket = new Array(opts.usuarios).fill(-1);

let subastaPrecioActual = 1000;
let subastaSiguienteMinimo = 1100;
let incrementoMinimo = 100;

async function sincronizarEstadoSubasta() {
  const url = `${opts.apiBase}/api/subastas/${opts.subastaId}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { 'Authorization': `Bearer ${compradores[0].token}` }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} al consultar subasta: ${await res.text()}`);
  }
  const data = await res.json();
  if (data.estado !== 'EN_CURSO') {
    throw new Error(`La subasta ${opts.subastaId} no está EN_CURSO (estado actual: ${data.estado})`);
  }
  incrementoMinimo = data.reglas?.incrementoMinimo || 100;
  subastaPrecioActual = data.precioActual || data.reglas?.precioBase || 1000;
  subastaSiguienteMinimo = data.siguienteMinimo || (subastaPrecioActual + incrementoMinimo);
  return data;
}

// Obtener ticket de un solo uso
async function obtenerTicket(token) {
  const url = `${opts.apiBase}/api/sesion/ticket-ws`;
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} al pedir ticket: ${await res.text()}`);
  }
  const data = await res.json();
  return data.ticket;
}

// Conectar un socket comprador
async function conectarComprador(indice) {
  const usuario = compradores[indice];
  try {
    const ticket = await obtenerTicket(usuario.token);
    const wsUrl = `${opts.wsBase}/ws/salas/${opts.subastaId}?ticket=${encodeURIComponent(ticket)}`;
    const ws = new WebSocket(wsUrl);

    const clientObj = {
      indice,
      usuario,
      ws,
      activo: false,
      pingInterval: null
    };

    return new Promise((resolve) => {
      const connectTimeout = setTimeout(() => {
        if (!clientObj.activo) {
          metricas.conexiones.erroresConexion++;
          ws.close();
          resolve(null);
        }
      }, 10000);

      ws.onopen = () => {
        clearTimeout(connectTimeout);
        clientObj.activo = true;
        metricas.conexiones.abiertasExitosas++;
        metricas.conexiones.picoConexionesActivas = Math.max(
          metricas.conexiones.picoConexionesActivas,
          sockets.filter(s => s && s.activo).length + 1
        );

        // Keep-alive PING cada 15 segundos
        clientObj.pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ tipo: 'PING' }));
          }
        }, 15000);

        resolve(clientObj);
      };

      ws.onmessage = (event) => {
        metricas.eventos.totalRecibidos++;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          if (midiendo) metricas.eventos.mensajesInvalidos++;
          return;
        }

        if (msg.tipo === 'PONG') return;

        // Validación de secuencia del sobre (debe ser estrictamente monotónica no decreciente)
        if (typeof msg.secuencia === 'number') {
          const ultima = secuenciasPorSocket[indice];
          if (ultima !== -1) {
            if (msg.secuencia === ultima) {
              metricas.eventos.duplicados++;
              if (metricas.eventos.duplicados <= 3) {
                console.warn(`[WARN WS #${indice}] Duplicado sobre: secuencia=${msg.secuencia}, tipo=${msg.tipo}`);
              }
            } else if (msg.secuencia < ultima) {
              metricas.eventos.fueraDeOrden++;
              if (metricas.eventos.fueraDeOrden <= 3) {
                console.warn(`[WARN WS #${indice}] Fuera de orden sobre: msg.secuencia=${msg.secuencia} < ultima=${ultima}, tipo=${msg.tipo}`);
              }
            }
          }
          secuenciasPorSocket[indice] = Math.max(ultima, msg.secuencia);
        }

        if (msg.tipo === 'PUJA_ACEPTADA') {
          metricas.eventos.pujaAceptadaRecibidos++;

          // Validación de secuencia de subasta (cantidadPujas debe ser consecutiva 1, 2, 3...)
          const cantidad = msg.datos?.cantidadPujas;
          if (midiendo) metricas.eventos.aceptadosPorSocket[indice].push({
            cantidad, monto: msg.datos?.monto, usuarioId: msg.datos?.usuarioId,
            recibidoIso: new Date().toISOString()
          });
          if (typeof cantidad === 'number') {
            const ultCant = cantidadesPujasPorSocket[indice];
            if (ultCant !== -1) {
              if (cantidad <= ultCant) {
                metricas.eventos.duplicados++;
                if (metricas.eventos.duplicados <= 3) {
                  console.warn(`[WARN WS #${indice}] Duplicado cantidadPujas: cantidad=${cantidad} <= ultCant=${ultCant}`);
                }
              } else if (cantidad > ultCant + 1) {
                metricas.eventos.perdidosGaps += (cantidad - ultCant - 1);
                if (metricas.eventos.perdidosGaps <= 5) {
                  console.warn(`[WARN WS #${indice}] Gap cantidadPujas: cantidad=${cantidad} > ultCant=${ultCant} + 1`);
                }
              }
            }
            cantidadesPujasPorSocket[indice] = cantidad;
          }

          const montoAceptado = msg.datos?.monto;
          const usuarioGanador = msg.datos?.usuarioId;
          if (montoAceptado) {
            if (montoAceptado > subastaPrecioActual) {
              subastaPrecioActual = montoAceptado;
              subastaSiguienteMinimo = msg.datos?.siguienteMinimo || (subastaPrecioActual + incrementoMinimo);
            }
            // Si teníamos esta puja en vuelo, medimos latencia punta a punta
            const claveAceptada = `${montoAceptado}-${usuarioGanador}`;
            if (midiendo && enviosFormales.has(claveAceptada)) {
              const pendiente = enviosFormales.get(claveAceptada);
              const latencia = performance.now() - pendiente.t0;
              if (!pendiente.receptores.has(indice)) {
                pendiente.receptores.add(indice);
                metricas.latenciasMs.push(latencia);
                const evento = metricas.eventos.aceptadosPorSocket[indice].at(-1);
                evento.latenciaMs = latencia;
                if (pendiente.estado === 'pendiente') metricas.pujas.aceptadas++;
                pendiente.estado = 'aceptada';
                pujasEnVuelo.delete(claveAceptada);
              }
            }
          }
        } else if (msg.tipo === 'PUJA_RECHAZADA') {
          const montoIntentado = msg.datos?.montoIntentado;
          const claveRechazada = `${montoIntentado}-${usuario.id}`;
          if (pujasEnVuelo.has(claveRechazada)) {
            if (midiendo) metricas.pujas.rechazadas++;
            pujasEnVuelo.get(claveRechazada).estado = 'rechazada';
            pujasEnVuelo.delete(claveRechazada);
          } else if (midiendo) {
            metricas.pujas.respuestasNoCorrelacionadas++;
          }
        } else if (msg.tipo === 'ERROR' && midiendo) {
          metricas.eventos.erroresAplicacion++;
        }
      };

      ws.onerror = (err) => {
        if (midiendo) metricas.pujas.erroresHttpOTransporte++;
      };

      ws.onclose = (event) => {
        if (clientObj.activo) {
          clientObj.activo = false;
          if (!cierreIntencional) metricas.conexiones.desconexiones++;
          if (midiendo && !cierreIntencional) metricas.conexiones.minimoDuranteCarga = sockets.filter(s => s && s.activo).length;
          if (!cierreIntencional && metricas.conexiones.desconexiones <= 5) {
            console.warn(`[WARN WS #${indice}] Desconectado: code=${event.code}, reason=${event.reason || 'sin_motivo'}`);
          }
          clearInterval(clientObj.pingInterval);
        }
      };
    });
  } catch (err) {
    metricas.conexiones.erroresConexion++;
    return null;
  }
}

// Fase 1: Conexión progresiva
async function faseConexion() {
  console.log(`[1/3] Conectando progresivamente ${opts.usuarios} clientes...`);
  const delayMs = Math.max(10, Math.floor((opts.rampup * 1000) / opts.usuarios));

  for (let i = 0; i < opts.usuarios; i++) {
    let client = await conectarComprador(i);
    if (!client) {
      await new Promise(r => setTimeout(r, 600));
      client = await conectarComprador(i);
    }
    sockets.push(client);
    if ((i + 1) % 25 === 0 || i === opts.usuarios - 1) {
      const activos = sockets.filter(s => s && s.activo).length;
      console.log(`  · ${i + 1}/${opts.usuarios} procesados (${activos} activos)`);
    }
    await new Promise(r => setTimeout(r, delayMs));
  }

  const activas = sockets.filter(s => s && s.activo).length;
  console.log(`✅ Conexiones listas: ${activas}/${opts.usuarios} activas.\n`);
  if (activas !== opts.usuarios) {
    throw new Error(`Se requieren ${opts.usuarios} conexiones; solo hay ${activas}`);
  }
}

// Fase 2: Envío de carga sostenida
async function faseCarga() {
  // Calentamiento previo (DoD: "Sin arranque en frío")
  console.log(`[Calentamiento] Calentando conexiones y pools de microservicios durante 5 segundos...`);
  for (let w = 0; w < 5; w++) {
    const s = sockets[w % sockets.length];
    if (s && s.activo) {
      s.ws.send(JSON.stringify({ tipo: 'PUJAR', monto: subastaSiguienteMinimo }));
    }
    await new Promise(r => setTimeout(r, 800));
  }
  await new Promise(r => setTimeout(r, 1000));
  metricas.latenciasMs = [];
  metricas.pujas.aceptadas = 0;
  metricas.pujas.rechazadas = 0;
  metricas.pujas.enviadas = 0;
  pujasEnVuelo.clear();
  enviosFormales.clear();
  const base = await sincronizarEstadoSubasta();
  metricas.baseline = { cantidadPujas: base.cantidadPujas, precioActual: base.precioActual, siguienteMinimo: base.siguienteMinimo };
  cantidadesPujasPorSocket.fill(base.cantidadPujas);
  secuenciasPorSocket.fill(-1);
  metricas.eventos.duplicados = 0;
  metricas.eventos.fueraDeOrden = 0;
  metricas.eventos.perdidosGaps = 0;
  console.log(`✅ Calentamiento completado. Iniciando medición formal de carga sostenida.\n`);

  console.log(`[2/3] Generando carga: ${opts.tasa} pujas/s durante ${opts.duracion} s...`);
  const intervaloMs = 1000 / opts.tasa;
  const tInicioFormal = performance.now();
  const tFin = tInicioFormal + (opts.duracion * 1000);
  metricas.ventana.inicioIso = new Date().toISOString();
  metricas.conexiones.minimoDuranteCarga = sockets.filter(s => s && s.activo).length;
  midiendo = true;
  let usuarioTurno = 0;
  let ultimoReporteLog = Date.now();

  let proximoEnvio = tInicioFormal;

  while (performance.now() < tFin) {
    const espera = proximoEnvio - performance.now();
    if (espera > 0) await new Promise(r => setTimeout(r, espera));
    if (performance.now() >= tFin) break;
    const tInicioCiclo = performance.now();

    // Encontrar un socket activo en round-robin
    let socketEmisor = null;
    let intentos = 0;
    while (!socketEmisor && intentos < opts.usuarios) {
      const candidato = sockets[usuarioTurno % sockets.length];
      usuarioTurno++;
      intentos++;
      if (candidato && candidato.activo && candidato.ws.readyState === WebSocket.OPEN
          && !enviosFormales.has(`${subastaSiguienteMinimo}-${candidato.usuario.id}`)) {
        socketEmisor = candidato;
      }
    }

    if (socketEmisor) {
      const montoPuja = subastaSiguienteMinimo;
      const clavePuja = `${montoPuja}-${socketEmisor.usuario.id}`;

      const t0 = performance.now();
      const corrId = `corr-load-${Date.now()}-${usuarioTurno}`;
      const intento = { t0, corrId, usuarioId: socketEmisor.usuario.id, estado: 'pendiente', receptores: new Set() };
      pujasEnVuelo.set(clavePuja, intento);
      enviosFormales.set(clavePuja, intento);

      try {
        socketEmisor.ws.send(JSON.stringify({
          tipo: 'PUJAR',
          monto: montoPuja
        }));
        metricas.pujas.enviadas++;
        const segundo = Math.floor((t0 - tInicioFormal) / 1000);
        metricas.enviosPorSegundo[segundo] = (metricas.enviosPorSegundo[segundo] || 0) + 1;
      } catch (e) {
        metricas.pujas.erroresHttpOTransporte++;
        pujasEnVuelo.delete(clavePuja);
      }
    }

    // Reporte periódico en consola cada 30 segundos
    if (Date.now() - ultimoReporteLog >= 30000) {
      ultimoReporteLog = Date.now();
      const p95Parcial = calcularPercentil(metricas.latenciasMs, 95);
      const activas = sockets.filter(s => s && s.activo).length;
      const faltanSeg = Math.max(0, Math.round((tFin - performance.now()) / 1000));
      console.log(`  [Progreso] Faltan ${faltanSeg}s | Pujas env: ${metricas.pujas.enviadas} | Aceptadas: ${metricas.pujas.aceptadas} | p95: ${p95Parcial.toFixed(1)}ms | WS Activos: ${activas}`);
    }

    // Esperar hasta el próximo tick manteniendo la tasa
    // No compensar un atasco con una ráfaga: una tasa insuficiente debe quedar visible.
    proximoEnvio = Math.max(proximoEnvio + intervaloMs, performance.now());
  }
  metricas.ventana.finIso = new Date().toISOString();
  metricas.ventana.duracionRealMs = performance.now() - tInicioFormal;

  // Pequeña gracia de 2 segundos para recibir los últimos eventos
  console.log(`  Esperando eventos residuales...`);
  await new Promise(r => setTimeout(r, 10000));
  const final = await sincronizarEstadoSubasta();
  metricas.estadoFinal = { cantidadPujas: final.cantidadPujas, precioActual: final.precioActual };
  metricas.pujas.pendientes = pujasEnVuelo.size;
  metricas.pujas.intentos = [...enviosFormales.entries()].map(([clave, i]) => ({clave, estado:i.estado, receptores:i.receptores.size}));
  midiendo = false;
}

// Calcular percentil
function calcularPercentil(array, p) {
  if (!array || array.length === 0) return 0;
  const sorted = [...array].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

// Fase 3: Consolidar y cerrar
function consolidar() {
  metricas.finIso = new Date().toISOString();
  metricas.conexiones.finalesActivas = sockets.filter(s => s && s.activo).length;

  const lat = metricas.latenciasMs;
  if (lat.length > 0) {
    const sorted = [...lat].sort((a, b) => a - b);
    metricas.resumenLatencia.min = sorted[0];
    metricas.resumenLatencia.max = sorted[sorted.length - 1];
    metricas.resumenLatencia.p50 = calcularPercentil(sorted, 50);
    metricas.resumenLatencia.p90 = calcularPercentil(sorted, 90);
    metricas.resumenLatencia.p95 = calcularPercentil(sorted, 95);
    metricas.resumenLatencia.p99 = calcularPercentil(sorted, 99);
    metricas.resumenLatencia.promedio = lat.reduce((a, b) => a + b, 0) / lat.length;
  }

  metricas.pujas.pujasPorSegundoEfectivas = metricas.pujas.enviadas / opts.duracion;

  // Cerrar sockets y timers
  cierreIntencional = true;
  for (const s of sockets) {
    if (s) {
      if (s.pingInterval) clearInterval(s.pingInterval);
      if (s.ws && s.ws.readyState === WebSocket.OPEN) {
        try { s.ws.close(); } catch {}
      }
    }
  }

  // Guardar JSON
  writeFileSync(opts.salida, JSON.stringify(metricas, null, 2), 'utf-8');
  console.log(`\nResultados JSON guardados en: ${opts.salida}`);

  // Guardar HTML
  const html = generarHtml(metricas);
  writeFileSync(opts.html, html, 'utf-8');
  console.log(`Reporte HTML guardado en: ${opts.html}`);

  imprimirResumen();
}

function imprimirResumen() {
  const r = metricas.resumenLatencia;
  const c = metricas.conexiones;
  const p = metricas.pujas;
  const e = metricas.eventos;

  console.log(`\n================== RESUMEN DE EJECUCIÓN ==================`);
  console.log(`  Etapa:                  ${metricas.etapa.toUpperCase()}`);
  console.log(`  Conexiones WS activas:  ${c.picoConexionesActivas} (Desconexiones: ${c.desconexiones})`);
  console.log(`  Pujas enviadas:         ${p.enviadas}`);
  console.log(`  Pujas aceptadas:        ${p.aceptadas}`);
  console.log(`  Pujas rechazadas:       ${p.rechazadas}`);
  console.log(`  Pujas/segundo reales:   ${p.pujasPorSegundoEfectivas.toFixed(2)}`);
  console.log(`  Latencia p50:           ${r.p50.toFixed(2)} ms`);
  console.log(`  Latencia p95:           ${r.p95.toFixed(2)} ms (Criterio: <= 800 ms)`);
  console.log(`  Latencia p99:           ${r.p99.toFixed(2)} ms (Criterio: <= 1500 ms)`);
  console.log(`  Latencia máx:           ${r.max.toFixed(2)} ms`);
  console.log(`  Eventos duplicados:     ${e.duplicados}`);
  console.log(`  Eventos fuera de orden: ${e.fueraDeOrden}`);
  console.log(`  Gaps de secuencia:      ${e.perdidosGaps}`);
  console.log(`==========================================================\n`);
}

function generarHtml(m) {
  const r = m.resumenLatencia;
  const c = m.conexiones;
  const p = m.pujas;
  const e = m.eventos;

  const cumpleP95 = r.p95 <= 800;
  const cumpleP99 = r.p99 <= 1500;
  const cumpleDesconexiones = c.desconexiones === 0;
  const cumpleDuplicados = e.duplicados === 0;
  const cumpleOrden = e.fueraDeOrden === 0;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>CaféOrbe · Reporte de Carga REN-01 (${m.etapa.toUpperCase()})</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; background: #f8fafc; color: #1e293b; }
    h1 { color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem; }
    .card { background: white; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid #e2e8f0; }
    th { background: #f1f5f9; font-weight: 600; }
    .badge { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; }
    .badge-pass { background: #dcfce7; color: #166534; }
    .badge-fail { background: #fee2e2; color: #991b1b; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .metric-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 1rem; text-align: center; }
    .metric-value { font-size: 1.8rem; font-weight: bold; color: #0284c7; }
    .metric-label { font-size: 0.85rem; color: #64748b; margin-top: 0.25rem; }
  </style>
</head>
<body>
  <h1>CaféOrbe · Reporte de Desempeño REN-01</h1>
  <div class="card">
    <h2>Resumen de Escenario: ${m.etapa.toUpperCase()}</h2>
    <p><strong>Subasta ID:</strong> ${m.subastaId}</p>
    <p><strong>Inicio:</strong> ${m.inicioIso} | <strong>Fin:</strong> ${m.finIso}</p>
    <div class="metric-grid">
      <div class="metric-box">
        <div class="metric-value">${c.picoConexionesActivas}</div>
        <div class="metric-label">Conexiones WebSocket</div>
      </div>
      <div class="metric-box">
        <div class="metric-value">${p.pujasPorSegundoEfectivas.toFixed(1)}</div>
        <div class="metric-label">Pujas/segundo</div>
      </div>
      <div class="metric-box">
        <div class="metric-value">${r.p95.toFixed(1)} ms</div>
        <div class="metric-label">Latencia p95 (Meta: &le; 800 ms)</div>
      </div>
      <div class="metric-box">
        <div class="metric-value">${r.p99.toFixed(1)} ms</div>
        <div class="metric-label">Latencia p99 (Meta: &le; 1500 ms)</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Criterios de Aceptación REN-01</h2>
    <table>
      <thead>
        <tr>
          <th>Métrica</th>
          <th>Objetivo</th>
          <th>Valor Medido</th>
          <th>Resultado</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Conexiones WebSocket concurrentes</td>
          <td>${m.configuracion.usuarios}</td>
          <td>${c.picoConexionesActivas}</td>
          <td><span class="badge ${c.picoConexionesActivas >= m.configuracion.usuarios ? 'badge-pass' : 'badge-fail'}">${c.picoConexionesActivas >= m.configuracion.usuarios ? 'CUMPLE' : 'NO CUMPLE'}</span></td>
        </tr>
        <tr>
          <td>Latencia p95 punta a punta</td>
          <td>&le; 800 ms</td>
          <td>${r.p95.toFixed(2)} ms</td>
          <td><span class="badge ${cumpleP95 ? 'badge-pass' : 'badge-fail'}">${cumpleP95 ? 'CUMPLE' : 'NO CUMPLE'}</span></td>
        </tr>
        <tr>
          <td>Latencia p99 punta a punta</td>
          <td>&le; 1500 ms</td>
          <td>${r.p99.toFixed(2)} ms</td>
          <td><span class="badge ${cumpleP99 ? 'badge-pass' : 'badge-fail'}">${cumpleP99 ? 'CUMPLE' : 'NO CUMPLE'}</span></td>
        </tr>
        <tr>
          <td>Conexiones caídas</td>
          <td>0</td>
          <td>${c.desconexiones}</td>
          <td><span class="badge ${cumpleDesconexiones ? 'badge-pass' : 'badge-fail'}">${cumpleDesconexiones ? 'CUMPLE' : 'NO CUMPLE'}</span></td>
        </tr>
        <tr>
          <td>Eventos duplicados</td>
          <td>0</td>
          <td>${e.duplicados}</td>
          <td><span class="badge ${cumpleDuplicados ? 'badge-pass' : 'badge-fail'}">${cumpleDuplicados ? 'CUMPLE' : 'NO CUMPLE'}</span></td>
        </tr>
        <tr>
          <td>Eventos fuera de orden</td>
          <td>0</td>
          <td>${e.fueraDeOrden}</td>
          <td><span class="badge ${cumpleOrden ? 'badge-pass' : 'badge-fail'}">${cumpleOrden ? 'CUMPLE' : 'NO CUMPLE'}</span></td>
        </tr>
        <tr>
          <td>Pujas aceptadas recibidas</td>
          <td>-</td>
          <td>${p.aceptadas} / ${p.enviadas}</td>
          <td><span class="badge badge-pass">REGISTRADO</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

// Ejecución
async function principal() {
  try {
    await sincronizarEstadoSubasta();
    await faseConexion();
    await faseCarga();
  } catch (err) {
    console.error('Error durante la ejecución:', err);
    metricas.errorEjecucion = err.message;
    process.exitCode = 1;
  } finally {
    consolidar();
  }
}

principal();
