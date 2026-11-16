// Verificación en vivo de los escenarios del Sprint 2 (HU-15 a HU-22) contra el backend.
// Usa subastas de 1 minuto, así que tarda cerca de 2 minutos.
// Para probar otro ambiente: API_URL=https://... WS_URL=wss://... node e2e-sprint2.mjs
import { sesionDePrueba } from './sesiones-de-prueba.mjs'
const API = process.env.API_URL ?? 'http://localhost:8080'
const WS = process.env.WS_URL ?? 'ws://localhost:8085'
const SALDO = Number(process.env.SALDO_INICIAL ?? 100000000)
const sufijo = Date.now().toString(36)

const resultados = []
function comprobar(hu, nombre, ok, detalle = '') {
  resultados.push({ hu, nombre, ok })
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${hu} · ${nombre}${ok ? '' : `  → ${detalle}`}`)
}

async function http(metodo, ruta, { token, cuerpo } = {}) {
  const headers = {}
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(API + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) })
  const texto = await r.text()
  let json = null
  try { json = texto ? JSON.parse(texto) : null } catch { /* no es JSON */ }
  return { status: r.status, json, texto }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

async function hasta(fn, ms = 8000, paso = 200) {
  const fin = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > fin) return null
    await esperar(paso)
  }
}

async function sala(subastaId, token) {
  // SEG-04: la URL lleva un ticket de un solo uso, nunca el token de sesión.
  const { json } = await http('POST', '/api/sesion/ticket-ws', { token })
  const ticket = json?.ticket ?? ''
  return new Promise((resolver) => {
    const ws = new WebSocket(`${WS}/ws/salas/${subastaId}?ticket=${encodeURIComponent(ticket)}`)
    const c = { ws, mensajes: [], abierta: false }
    c.ultimo = (tipo) => [...c.mensajes].reverse().find((m) => m.tipo === tipo)
    c.cuenta = (tipo) => c.mensajes.filter((m) => m.tipo === tipo).length
    c.enviar = (m) => ws.send(JSON.stringify(m))
    c.cerrar = () => ws.close()
    ws.onopen = () => { c.abierta = true; resolver(c) }
    ws.onmessage = (e) => c.mensajes.push({ ...JSON.parse(e.data), en: Date.now() })
    ws.onerror = () => resolver(c)
  })
}

async function sesion(nombre, rol) {
  // SEG-01: no hay login propio; la sesión la firma la herramienta del operador (sesiones-de-prueba.mjs).
  const r = await sesionDePrueba(nombre, rol)
  return { token: r.token, id: r.usuario.id, nombre }
}

async function crearSubasta(luis, nombre) {
  const r = await http('POST', '/api/subastas', { token: luis.token, cuerpo: { nombre, descripcion: 'Verificación Sprint 2', fechaInicio: new Date(Date.now() + 30 * 60_000).toISOString() } })
  const id = r.json.id
  await http('PUT', `/api/subastas/${id}/ficha`, { token: luis.token, cuerpo: { identificacion: 'S2-001', tipoCafe: 'Caturra', pesoKg: 50, edadMeses: 1, observaciones: '' } })
  await http('PUT', `/api/subastas/${id}/reglas`, { token: luis.token, cuerpo: { duracionMinutos: 1, precioBase: 100, incrementoMinimo: 10 } })
  return id
}

/** Tiempo restante que vería un cliente: hora de fin menos el reloj del servidor estimado. */
function restanteSegun(detalle, recibidoEn) {
  const desfase = Date.parse(detalle.horaServidor) - recibidoEn
  return (Date.parse(detalle.horaFin) - (Date.now() + desfase)) / 1000
}

async function main() {
  const luis = await sesion(`Luis s2 ${sufijo}`, 'SUBASTADOR')
  const ana = await sesion(`Ana s2 ${sufijo}`, 'COMPRADOR')
  const bea = await sesion(`Bea s2 ${sufijo}`, 'COMPRADOR')
  const cata = await sesion(`Cata s2 ${sufijo}`, 'COMPRADOR')
  await hasta(async () => (await http('GET', '/api/orbes/saldo', { token: bea.token })).json?.saldo === SALDO)

  const subasta = await crearSubasta(luis, `Lote S2 ${sufijo}`)
  const desierta = await crearSubasta(luis, `Lote sin pujas ${sufijo}`)

  const sLuis = await sala(subasta, luis.token)
  const sAna = await sala(subasta, ana.token)
  const sBea = await sala(subasta, bea.token)

  // ── HU-15 · Conteo de conectados ───────────────────────────────────────
  const tres = await hasta(() => sLuis.ultimo('CONECTADOS')?.datos.conectados === 3 && sAna.ultimo('CONECTADOS')?.datos.conectados === 3)
  comprobar('HU-15', 'hay 3 usuarios conectados', !!tres, JSON.stringify(sLuis.ultimo('CONECTADOS')))
  const sCata = await sala(subasta, cata.token)
  const cuatro = await hasta(() => [sLuis, sAna, sBea, sCata].every((s) => s.ultimo('CONECTADOS')?.datos.conectados === 4))
  comprobar('HU-15', 'entra un cuarto y todos ven el contador en 4 sin recargar', !!cuatro)
  const rSinTx = await http('GET', `/api/streaming/subastas/${subasta}/credenciales`, { token: ana.token })
  comprobar('HU-15', 'sin transmisión: "La transmisión aún no ha iniciado"', rSinTx.status === 409 && rSinTx.json?.mensaje === 'La transmisión aún no ha iniciado', rSinTx.texto)

  // ── Inicio de las dos subastas ─────────────────────────────────────────
  await http('POST', `/api/subastas/${desierta}/iniciar`, { token: luis.token })
  const rIni = await http('POST', `/api/subastas/${subasta}/iniciar`, { token: luis.token })
  const inicio = Date.now()

  // ── HU-16 · Líder y precio (subasta sin pujas) ─────────────────────────
  comprobar('HU-16', 'subasta sin pujas: se ve el precio base y no hay líder', rIni.json?.precioActual === 100 && rIni.json?.lider === null && rIni.json?.cantidadPujas === 0, rIni.texto)

  // ── HU-17 · Temporizador ───────────────────────────────────────────────
  const t1 = Date.now(); const d1 = (await http('GET', `/api/subastas/${subasta}`, { token: ana.token })).json; const r1 = Date.now()
  comprobar('HU-17', 'el servidor entrega hora de fin, hora del servidor y tiempo restante', !!d1.horaFin && !!d1.horaServidor && d1.segundosRestantes > 50 && d1.segundosRestantes <= 60, JSON.stringify({ f: d1.horaFin, s: d1.horaServidor, r: d1.segundosRestantes }))
  await esperar(1500)
  const t2 = Date.now(); const d2 = (await http('GET', `/api/subastas/${subasta}`, { token: bea.token })).json; const r2 = Date.now()
  const diferencia = Math.abs(restanteSegun(d1, (t1 + r1) / 2) - restanteSegun(d2, (t2 + r2) / 2))
  comprobar('HU-17', `dos clientes calculan el mismo tiempo restante (diferencia ${diferencia.toFixed(2)} s, límite 2 s)`, diferencia < 2, `dif=${diferencia}`)

  // ── HU-16 · Actualización tras una puja ────────────────────────────────
  sAna.enviar({ tipo: 'PUJAR', monto: 110 })
  const p1 = await hasta(() => sBea.ultimo('PUJA_ACEPTADA'))
  // A cada conexión le llega por separado: se espera a que la reciban Luis y Cata, y un margen más para que una
  // entrega doble, si la hubiera, alcance a llegar y la cuenta de 1 la detecte.
  await hasta(() => sLuis.cuenta('PUJA_ACEPTADA') >= 1 && sCata.cuenta('PUJA_ACEPTADA') >= 1, 3000)
  await esperar(500)
  comprobar('HU-16', 'otro comprador puja: todos ven el nuevo precio y el nombre del líder sin recargar', p1?.datos.monto === 110 && p1.datos.usuarioNombre === ana.nombre && sLuis.cuenta('PUJA_ACEPTADA') === 1 && sCata.cuenta('PUJA_ACEPTADA') === 1, JSON.stringify({ luis: sLuis.cuenta('PUJA_ACEPTADA'), cata: sCata.cuenta('PUJA_ACEPTADA'), p1 }))
  comprobar('HU-18', 'una puja lejos del final no extiende el tiempo', sAna.cuenta('TIEMPO_EXTENDIDO') === 0)

  // ── HU-18 · Anti-sniping: puja con 15 s restantes ──────────────────────
  const finOriginal = Date.parse(rIni.json.horaFin)
  const desfase = Date.parse(d1.horaServidor) - (t1 + r1) / 2
  const faltan = () => (finOriginal - (Date.now() + desfase)) / 1000
  console.log(`       (esperando a que queden 15 s; ahora faltan ${faltan().toFixed(0)} s)`)
  await hasta(() => faltan() <= 15, 70_000, 250)
  sBea.enviar({ tipo: 'PUJAR', monto: 120 })
  const ext = await hasta(() => sAna.ultimo('TIEMPO_EXTENDIDO'))
  comprobar('HU-18', 'puja válida con 15 s restantes: el tiempo se extiende 30 s', ext?.datos.segundosExtendidos === 30 && Date.parse(ext.datos.horaFin) === finOriginal + 30_000 && ext.datos.extension === 1, JSON.stringify(ext))
  comprobar('HU-18', 'el aviso de tiempo extendido llega a todos los conectados', [sLuis, sAna, sBea, sCata].every((s) => s.cuenta('TIEMPO_EXTENDIDO') === 1))
  const dExt = (await http('GET', `/api/subastas/${subasta}`, { token: ana.token })).json
  comprobar('HU-18', 'la extensión queda registrada en la subasta', dExt.extensiones === 1 && Date.parse(dExt.horaFin) === finOriginal + 30_000 && dExt.estado === 'EN_CURSO', JSON.stringify({ e: dExt.extensiones, f: dExt.horaFin }))
  await hasta(() => faltan() <= -2, 30_000, 250)
  const dTrasFin = (await http('GET', `/api/subastas/${subasta}`, { token: ana.token })).json
  comprobar('HU-18', 'pasada la hora de fin original la subasta sigue En curso, porque se extendió', dTrasFin.estado === 'EN_CURSO', dTrasFin.estado)

  // ── HU-19 · Cierre sin pujas, sin nadie en la sala ─────────────────────
  const cierreDesierta = await hasta(async () => (await http('GET', `/api/subastas/${desierta}`, { token: ana.token })).json?.estado === 'DESIERTA', 40_000, 500)
  comprobar('HU-19', 'cierre sin pujas: queda Desierta aunque nadie tenga la sala abierta', !!cierreDesierta)
  const rDes = await http('GET', `/api/subastas/${desierta}/resultados`, { token: ana.token })
  comprobar('HU-22', 'resultados de la subasta desierta: sin ganador ni monto final', rDes.status === 200 && rDes.json?.ganador === null && rDes.json.montoFinal === null && rDes.json.cantidadPujas === 0, rDes.texto)

  // ── HU-19 y HU-21 · Cierre con ganador ─────────────────────────────────
  console.log(`       (esperando el cierre automático; inició hace ${((Date.now() - inicio) / 1000).toFixed(0)} s)`)
  const cerrada = await hasta(() => sAna.ultimo('SUBASTA_CERRADA'), 60_000, 250)
  comprobar('HU-19', 'al llegar a cero el servidor cierra la subasta: Finalizada', cerrada?.datos.estado === 'FINALIZADA', JSON.stringify(cerrada))
  comprobar('HU-19', 'la última puja válida queda como ganadora', cerrada?.datos.ganadorId === bea.id && cerrada.datos.montoFinal === 120 && cerrada.datos.cantidadPujas === 2, JSON.stringify(cerrada?.datos))
  const cierreReal = cerrada ? (Date.parse(cerrada.datos.cerradaEn) - (finOriginal + 30_000)) / 1000 : null
  comprobar('HU-19', `cierra al terminar el tiempo extendido (${cierreReal?.toFixed(1)} s después de la hora de fin)`, cierreReal !== null && cierreReal >= 0 && cierreReal < 5, `cierre=${cierreReal}`)
  comprobar('HU-21', 'todos los conectados ven el anuncio con el nombre del ganador y el monto final', [sLuis, sAna, sBea, sCata].every((s) => s.ultimo('SUBASTA_CERRADA')?.datos.ganadorNombre === bea.nombre && s.ultimo('SUBASTA_CERRADA').datos.montoFinal === 120))

  // ── HU-19 · Puja tardía ────────────────────────────────────────────────
  sAna.enviar({ tipo: 'PUJAR', monto: 130 })
  const tardia = await hasta(() => sAna.ultimo('PUJA_RECHAZADA'))
  comprobar('HU-19', 'puja tardía: se rechaza con "La subasta ya finalizó"', tardia?.datos.mensaje === 'La subasta ya finalizó' && tardia.datos.motivo === 'SUBASTA_FINALIZADA', JSON.stringify(tardia))
  const dFin = (await http('GET', `/api/subastas/${subasta}`, { token: ana.token })).json
  comprobar('HU-19', 'la puja tardía no cambia el resultado', dFin.estado === 'FINALIZADA' && dFin.precioActual === 120 && dFin.lider.id === bea.id, JSON.stringify({ e: dFin.estado, p: dFin.precioActual }))

  // ── HU-20 · Cobro al ganador ───────────────────────────────────────────
  const cobrado = await hasta(async () => (await http('GET', '/api/orbes/saldo', { token: bea.token })).json?.saldo === SALDO - 120, 10_000, 300)
  comprobar('HU-20', `el ganador queda con su saldo menos el monto final (${SALDO - 120})`, !!cobrado, (await http('GET', '/api/orbes/saldo', { token: bea.token })).texto)
  const movs = (await http('GET', '/api/orbes/movimientos', { token: bea.token })).json ?? []
  const cobro = movs.find((m) => m.tipo === 'COBRO')
  comprobar('HU-20', 'el cobro queda registrado en su historial', !!cobro && cobro.monto === -120 && cobro.referencia === subasta && movs.filter((m) => m.tipo === 'COBRO').length === 1, JSON.stringify(movs))
  const saldoAna = (await http('GET', '/api/orbes/saldo', { token: ana.token })).json?.saldo
  comprobar('HU-20', 'quien pujó pero no ganó conserva su saldo', saldoAna === SALDO, `saldo=${saldoAna}`)
  const aviso = await hasta(() => sBea.ultimo('ORBES_COBRADOS'), 5000)
  comprobar('HU-20', 'el aviso de cobro llega solo al ganador, con su saldo nuevo', aviso?.datos.saldo === SALDO - 120 && sAna.cuenta('ORBES_COBRADOS') === 0 && sLuis.cuenta('ORBES_COBRADOS') === 0, JSON.stringify(aviso))

  // ── HU-22 · Resultados ─────────────────────────────────────────────────
  const rAna = await http('GET', `/api/subastas/${subasta}/resultados`, { token: ana.token })
  const rLuis = await http('GET', `/api/subastas/${subasta}/resultados`, { token: luis.token })
  const res = rAna.json
  comprobar('HU-22', 'resumen: lote, ganador, monto final, cantidad de pujas e historial con hora', rAna.status === 200 && res.ficha?.tipoCafe === 'Caturra' && res.ganador?.id === bea.id && res.montoFinal === 120 && res.cantidadPujas === 2 && res.ultimasPujas.length === 2 && res.ultimasPujas[0].monto === 120 && !!res.ultimasPujas[0].creadaEn, rAna.texto)
  comprobar('HU-22', 'un Comprador que no ganó ve el mismo resumen que el Subastador', rAna.texto === rLuis.texto)

  // ── El listado ya no ofrece las subastas cerradas ──────────────────────
  const lista = (await http('GET', '/api/subastas?estado=programada,en_curso', { token: ana.token })).json ?? []
  comprobar('HU-19', 'las subastas cerradas salen del listado de disponibles', !lista.some((s) => s.id === subasta || s.id === desierta))

  for (const s of [sLuis, sAna, sBea, sCata]) s.cerrar()

  const porHu = {}
  for (const r of resultados) {
    porHu[r.hu] ??= { ok: 0, total: 0 }
    porHu[r.hu].total++
    if (r.ok) porHu[r.hu].ok++
  }
  console.log('\nResumen por historia:')
  for (const hu of Object.keys(porHu).sort()) console.log(`  ${hu}: ${porHu[hu].ok}/${porHu[hu].total}`)
  const fallas = resultados.filter((r) => !r.ok)
  console.log(`\nTOTAL: ${resultados.length - fallas.length}/${resultados.length}`)
  process.exit(fallas.length ? 1 : 0)
}

main().catch((e) => {
  console.error('ERROR INESPERADO', e)
  process.exit(2)
})
