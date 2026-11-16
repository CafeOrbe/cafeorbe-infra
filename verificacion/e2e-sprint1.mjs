// Verificación en vivo de los escenarios del Sprint 1 (HU-01 a HU-14) contra el backend en Docker.
// REST por el api-gateway (8080) y WebSocket por el realtime-gateway (8085).
// Para probar otro ambiente: API_URL=https://... WS_URL=wss://... node e2e-sprint1.mjs
import { sesionDePrueba } from './sesiones-de-prueba.mjs'
const API = process.env.API_URL ?? 'http://localhost:8080'
const WS = process.env.WS_URL ?? 'ws://localhost:8085'
// Orbes de la carga automática del ambiente que se prueba (WALLET_SALDO_INICIAL).
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

async function hasta(fn, ms = 6000, paso = 150) {
  const fin = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > fin) return null
    await esperar(paso)
  }
}

/** Cliente de sala: guarda todos los mensajes recibidos con su hora. */
async function sala(subastaId, token) {
  // SEG-04: la URL lleva un ticket de un solo uso, nunca el token de sesión.
  const { json } = await http('POST', '/api/sesion/ticket-ws', { token })
  const ticket = json?.ticket ?? ''
  return new Promise((resolver) => {
    const ws = new WebSocket(`${WS}/ws/salas/${subastaId}?ticket=${encodeURIComponent(ticket)}`)
    const c = { ws, mensajes: [], abierta: false, fallo: false }
    c.ultimo = (tipo) => [...c.mensajes].reverse().find((m) => m.tipo === tipo)
    c.cuenta = (tipo) => c.mensajes.filter((m) => m.tipo === tipo).length
    c.enviar = (m) => ws.send(JSON.stringify(m))
    c.cerrar = () => ws.close()
    ws.onopen = () => { c.abierta = true; resolver(c) }
    ws.onmessage = (e) => c.mensajes.push({ ...JSON.parse(e.data), en: Date.now() })
    ws.onerror = () => { c.fallo = true; resolver(c) }
    ws.onclose = () => { if (!c.abierta) { c.fallo = true; resolver(c) } }
  })
}

const enMinutos = (m) => new Date(Date.now() + m * 60_000).toISOString()

async function main() {
  // ── HU-01 / SEG-01 · Iniciar sesión ────────────────────────────────────
  // Solo se entra con Google: el acceso por nombre ya no existe y un ID token falso no crea sesión.
  const rNombre = await http('POST', '/api/sesion', { cuerpo: { nombre: `Intruso ${sufijo}`, rol: 'COMPRADOR' } })
  comprobar('SEG-01', 'no hay login propio: POST /api/sesion por nombre → 401', rNombre.status === 401, rNombre.texto)
  const rFalso = await http('POST', '/api/sesion/google', { cuerpo: { idToken: 'no-es-un-token-de-google', rol: 'COMPRADOR' } })
  comprobar('SEG-01', 'ID token de Google falso → 401 sin crear sesión', rFalso.status === 401 && !rFalso.json?.token, rFalso.texto)
  // Las personas de prueba no pueden usar Google: su sesión la firma la herramienta del operador.
  const rAna = { json: await sesionDePrueba(`Ana ${sufijo}`, 'COMPRADOR') }
  const rLuis = { json: await sesionDePrueba(`Luis ${sufijo}`, 'SUBASTADOR') }
  const ana = { token: rAna.json.token, id: rAna.json.usuario.id }
  const luis = { token: rLuis.json.token, id: rLuis.json.usuario.id }
  const rTicket = await http('POST', '/api/sesion/ticket-ws', { token: ana.token })
  comprobar('HU-01', 'la sesión firmada sirve en identity (ticket WebSocket)', rTicket.status === 201 && !!rTicket.json?.ticket, rTicket.texto)
  const rBea = { json: await sesionDePrueba(`Bea ${sufijo}`, 'COMPRADOR') }
  const bea = { token: rBea.json.token, id: rBea.json.usuario.id }
  const rOtro = { json: await sesionDePrueba(`Otro ${sufijo}`, 'SUBASTADOR') }
  const otro = { token: rOtro.json.token }

  // ── HU-02 · Cerrar sesión (lado servidor: sin token no hay acceso) ─────
  const rSinToken = await http('GET', '/api/subastas')
  comprobar('HU-02', 'sin token el gateway responde 401', rSinToken.status === 401, rSinToken.texto)
  const rTokenMalo = await http('GET', '/api/subastas', { token: 'no-es-un-token' })
  comprobar('HU-02', 'token inválido → 401', rTokenMalo.status === 401, rTokenMalo.texto)

  // ── HU-07 · Carga automática ───────────────────────────────────────────
  const saldoAna = await hasta(async () => {
    const r = await http('GET', '/api/orbes/saldo', { token: ana.token })
    return r.json?.saldo > 0 ? r.json.saldo : null
  })
  comprobar('HU-07', `primer ingreso: saldo inicial configurado (${SALDO})`, saldoAna === SALDO, `saldo=${saldoAna}`)
  const movs = await http('GET', '/api/orbes/movimientos', { token: ana.token })
  comprobar('HU-07', 'movimiento "Carga automática" registrado', movs.json?.length === 1 && movs.json[0].tipo === 'CARGA_AUTOMATICA' && movs.json[0].monto === SALDO, movs.texto)
  // Segundo ingreso de la misma persona: wallet recibe otra vez UsuarioRegistrado con el mismo eventId.
  const rAna2 = { json: await sesionDePrueba(`ana ${sufijo}`, 'COMPRADOR') }
  await esperar(1200)
  const saldoAna2 = (await http('GET', '/api/orbes/saldo', { token: rAna2.json.token })).json?.saldo
  const movs2 = await http('GET', '/api/orbes/movimientos', { token: rAna2.json.token })
  comprobar('HU-07', 'segundo ingreso: mismo usuario, sin doble carga', rAna2.json.usuario.id === ana.id && saldoAna2 === SALDO && movs2.json.length === 1, `saldo=${saldoAna2} movs=${movs2.json?.length}`)

  // ── HU-06 · Saldo ──────────────────────────────────────────────────────
  const rSaldo = await http('GET', '/api/orbes/saldo', { token: ana.token })
  comprobar('HU-06', 'GET /api/orbes/saldo devuelve el saldo del usuario autenticado', rSaldo.status === 200 && rSaldo.json.usuarioId === ana.id && rSaldo.json.saldo === SALDO, rSaldo.texto)
  const rSaldoLuis = await http('GET', '/api/orbes/saldo', { token: luis.token })
  comprobar('HU-06', 'el saldo nunca es negativo (Subastador sin cuenta → 0)', rSaldoLuis.json?.saldo === 0, rSaldoLuis.texto)

  // ── HU-08 · Crear subasta ──────────────────────────────────────────────
  const rCrear = await http('POST', '/api/subastas', { token: luis.token, cuerpo: { nombre: `Lote A ${sufijo}`, descripcion: 'Geisha lavado', fechaInicio: enMinutos(30) } })
  comprobar('HU-08', 'creación exitosa queda Programada', rCrear.status === 201 && rCrear.json?.estado === 'PROGRAMADA', rCrear.texto)
  const subasta = rCrear.json.id
  const rFaltan = await http('POST', '/api/subastas', { token: luis.token, cuerpo: { nombre: '', descripcion: '' } })
  comprobar('HU-08', 'campos obligatorios → 400 señalando nombre y fecha', rFaltan.status === 400 && !!rFaltan.json?.campos?.nombre && !!rFaltan.json?.campos?.fechaInicio, rFaltan.texto)
  const rPasado = await http('POST', '/api/subastas', { token: luis.token, cuerpo: { nombre: 'Vieja', descripcion: '', fechaInicio: enMinutos(-60 * 24) } })
  comprobar('HU-08', 'fecha en el pasado → 400 "La fecha de inicio debe ser futura"', rPasado.status === 400 && rPasado.json?.mensaje === 'La fecha de inicio debe ser futura' && !!rPasado.json?.campos?.fechaInicio, rPasado.texto)
  const rCompradorCrea = await http('POST', '/api/subastas', { token: ana.token, cuerpo: { nombre: 'x', descripcion: '', fechaInicio: enMinutos(30) } })
  comprobar('HU-08', 'un Comprador no puede crear subastas (403)', rCompradorCrea.status === 403, rCompradorCrea.texto)

  // ── HU-03 · Home del Subastador ────────────────────────────────────────
  const rMias = await http('GET', '/api/subastas/mias', { token: luis.token })
  comprobar('HU-03', 'GET /api/subastas/mias devuelve solo las propias', rMias.status === 200 && rMias.json.length === 1 && rMias.json[0].id === subasta, rMias.texto)
  const rMiasOtro = await http('GET', '/api/subastas/mias', { token: otro.token })
  comprobar('HU-03', 'otro Subastador no ve las ajenas', rMiasOtro.status === 200 && rMiasOtro.json.length === 0, rMiasOtro.texto)
  const rMiasAna = await http('GET', '/api/subastas/mias', { token: ana.token })
  comprobar('HU-03', 'un Comprador recibe 403 "No autorizado"', rMiasAna.status === 403 && rMiasAna.json?.mensaje === 'No autorizado', rMiasAna.texto)

  // ── HU-04 · Home del Comprador ─────────────────────────────────────────
  const rLista = await http('GET', '/api/subastas?estado=programada,en_curso', { token: ana.token })
  const enLista = rLista.json?.find((s) => s.id === subasta)
  const fechas = rLista.json?.map((s) => Date.parse(s.fechaInicio)) ?? []
  comprobar('HU-04', 'la subasta Programada aparece en el listado con id, nombre y estado', rLista.status === 200 && enLista?.nombre === `Lote A ${sufijo}` && enLista?.estado === 'PROGRAMADA', rLista.texto.slice(0, 300))
  comprobar('HU-04', 'el listado viene ordenado por fecha', fechas.every((f, i) => i === 0 || fechas[i - 1] <= f))
  comprobar('HU-04', 'solo trae Programadas y En curso', rLista.json.every((s) => s.estado === 'PROGRAMADA' || s.estado === 'EN_CURSO'))
  const rFiltroMalo = await http('GET', '/api/subastas?estado=cualquiera', { token: ana.token })
  comprobar('HU-04', 'estado inválido → 400', rFiltroMalo.status === 400, rFiltroMalo.texto)

  // ── HU-09 · Ficha técnica ──────────────────────────────────────────────
  const ficha = { identificacion: 'LOTE-001', tipoCafe: 'Geisha', pesoKg: 69.5, edadMeses: 3, observaciones: 'Notas florales' }
  const rFicha = await http('PUT', `/api/subastas/${subasta}/ficha`, { token: luis.token, cuerpo: ficha })
  comprobar('HU-09', 'registro de la ficha asociada a la subasta', rFicha.status === 200 && rFicha.json?.ficha?.tipoCafe === 'Geisha' && rFicha.json.ficha.pesoKg === 69.5, rFicha.texto)
  const rDetalleAna = await http('GET', `/api/subastas/${subasta}`, { token: ana.token })
  comprobar('HU-09', 'la ficha es visible para el Comprador en la sala', rDetalleAna.json?.ficha?.identificacion === 'LOTE-001' && rDetalleAna.json.ficha.observaciones === 'Notas florales', rDetalleAna.texto)
  const rFichaLarga = await http('PUT', `/api/subastas/${subasta}/ficha`, { token: luis.token, cuerpo: { ...ficha, identificacion: 'x'.repeat(101) } })
  comprobar('HU-09', '101 caracteres → 400 junto al campo (no 500)', rFichaLarga.status === 400 && !!rFichaLarga.json?.campos?.identificacion, rFichaLarga.texto)
  const rFichaAjena = await http('PUT', `/api/subastas/${subasta}/ficha`, { token: otro.token, cuerpo: ficha })
  comprobar('HU-09', 'otro Subastador no puede editar la ficha (403)', rFichaAjena.status === 403, rFichaAjena.texto)

  // ── HU-12 (negativo) · Iniciar sin configuración ───────────────────────
  const rSinReglas = await http('POST', `/api/subastas/${subasta}/iniciar`, { token: luis.token })
  const estadoTras = (await http('GET', `/api/subastas/${subasta}`, { token: luis.token })).json?.estado
  comprobar('HU-12', 'inicio sin configuración → 409 "Configura primero el tiempo y las reglas de puja"', rSinReglas.status === 409 && rSinReglas.json?.mensaje === 'Configura primero el tiempo y las reglas de puja' && estadoTras === 'PROGRAMADA', rSinReglas.texto)

  // ── HU-10 · Reglas ─────────────────────────────────────────────────────
  const rReglas0 = await http('PUT', `/api/subastas/${subasta}/reglas`, { token: luis.token, cuerpo: { duracionMinutos: 10, precioBase: 0, incrementoMinimo: 10 } })
  comprobar('HU-10', 'precio base 0 → 400 "Los valores deben ser mayores que cero"', rReglas0.status === 400 && rReglas0.json?.mensaje === 'Los valores deben ser mayores que cero' && !!rReglas0.json.campos?.precioBase, rReglas0.texto)
  const rInc0 = await http('PUT', `/api/subastas/${subasta}/reglas`, { token: luis.token, cuerpo: { duracionMinutos: 10, precioBase: 100, incrementoMinimo: 0 } })
  const sinGuardar = (await http('GET', `/api/subastas/${subasta}`, { token: luis.token })).json?.reglas
  comprobar('HU-10', 'incremento 0 → 400 y no guarda', rInc0.status === 400 && rInc0.json?.mensaje === 'Los valores deben ser mayores que cero' && sinGuardar === null, rInc0.texto)
  const rDecimal = await http('PUT', `/api/subastas/${subasta}/reglas`, { token: luis.token, cuerpo: { duracionMinutos: 1.5, precioBase: 100, incrementoMinimo: 10 } })
  comprobar('HU-10', 'decimal 1.5 → 400 (no se trunca)', rDecimal.status === 400 && !!rDecimal.json?.campos?.duracionMinutos, rDecimal.texto)
  const rReglas = await http('PUT', `/api/subastas/${subasta}/reglas`, { token: luis.token, cuerpo: { duracionMinutos: 10, precioBase: 100, incrementoMinimo: 10 } })
  comprobar('HU-10', 'configuración válida (10 min, base 100, incremento 10) asociada a la subasta', rReglas.status === 200 && rReglas.json?.reglas?.precioBase === 100 && rReglas.json.reglas.incrementoMinimo === 10 && rReglas.json.reglas.version === 1, rReglas.texto)

  // ── HU-05 · Entrar a la sala ───────────────────────────────────────────
  const sLuis = await sala(subasta, luis.token)
  const sAna = await sala(subasta, ana.token)
  comprobar('HU-05', 'la sala abre por WebSocket', sLuis.abierta && sAna.abierta)
  const dos = await hasta(() => sLuis.ultimo('CONECTADOS')?.datos.conectados === 2)
  comprobar('HU-05', 'al entrar se registra la conexión (2 conectados)', !!dos, JSON.stringify(sLuis.ultimo('CONECTADOS')))
  const sBea = await sala(subasta, bea.token)
  const tres = await hasta(() => sAna.ultimo('CONECTADOS')?.datos.conectados === 3)
  comprobar('HU-05', 'entra un tercero y todos ven 3 sin recargar', !!tres, JSON.stringify(sAna.ultimo('CONECTADOS')))
  const sBea2 = await sala(subasta, bea.token)
  await esperar(500)
  comprobar('HU-05', 'la misma persona en dos pestañas cuenta una sola vez', sAna.ultimo('CONECTADOS')?.datos.conectados === 3, JSON.stringify(sAna.ultimo('CONECTADOS')))
  sBea2.cerrar()
  await esperar(400)
  const rDetalleSala = await http('GET', `/api/subastas/${subasta}`, { token: ana.token })
  comprobar('HU-05', 'la sala muestra el lote y el precio actual', rDetalleSala.json?.ficha !== null && rDetalleSala.json?.precioActual === 100 && rDetalleSala.json?.siguienteMinimo === 110, rDetalleSala.texto)
  const sFantasma = await sala('00000000-0000-4000-8000-000000000000', ana.token)
  comprobar('HU-05', 'una subasta inexistente no abre sala', sFantasma.fallo && !sFantasma.abierta)
  const rInexistente = await http('GET', '/api/subastas/00000000-0000-4000-8000-000000000000', { token: ana.token })
  comprobar('HU-05', 'el detalle de una subasta inexistente responde 404 (la sala muestra el error)', rInexistente.status === 404 && rInexistente.json?.mensaje === 'La subasta no existe', rInexistente.texto)
  const sSinToken = await sala(subasta, 'token-falso')
  comprobar('HU-05', 'sin sesión válida no se entra a la sala', sSinToken.fallo && !sSinToken.abierta)

  // ── HU-11 · Transmisión ────────────────────────────────────────────────
  const rEstado0 = await http('GET', `/api/streaming/subastas/${subasta}/estado`, { token: ana.token })
  comprobar('HU-11', 'estado inicial: no transmitiendo', rEstado0.status === 200 && rEstado0.json?.transmitiendo === false, rEstado0.texto)
  const rCredAntes = await http('GET', `/api/streaming/subastas/${subasta}/credenciales`, { token: ana.token })
  comprobar('HU-11', 'sin transmisión no hay credenciales de espectador (409)', rCredAntes.status === 409, rCredAntes.texto)
  const rAjeno = await http('POST', `/api/streaming/subastas/${subasta}/iniciar`, { token: otro.token })
  comprobar('HU-11', 'otro Subastador no puede transmitir en una subasta ajena (403)', rAjeno.status === 403, rAjeno.texto)
  const rCompradorTx = await http('POST', `/api/streaming/subastas/${subasta}/iniciar`, { token: ana.token })
  comprobar('HU-11', 'un Comprador no puede transmitir (403)', rCompradorTx.status === 403, rCompradorTx.texto)
  const rTx = await http('POST', `/api/streaming/subastas/${subasta}/iniciar`, { token: luis.token })
  comprobar('HU-11', 'iniciar transmisión entrega credenciales de la sala de video', rTx.status === 200 && !!rTx.json?.token && !!rTx.json?.url && !!rTx.json?.sala, rTx.texto)
  const enVivo = await hasta(() => sAna.cuenta('TRANSMISION_INICIADA') > 0)
  comprobar('HU-11', 'los conectados reciben TRANSMISION_INICIADA (indicador EN VIVO)', !!enVivo)
  const rEstado1 = await http('GET', `/api/streaming/subastas/${subasta}/estado`, { token: ana.token })
  comprobar('HU-11', 'el servidor expone transmitiendo = sí', rEstado1.json?.transmitiendo === true, rEstado1.texto)
  const rCred = await http('GET', `/api/streaming/subastas/${subasta}/credenciales`, { token: ana.token })
  comprobar('HU-11', 'el Comprador obtiene credenciales para ver el video', rCred.status === 200 && !!rCred.json?.token, rCred.texto)
  const rStop = await http('POST', `/api/streaming/subastas/${subasta}/detener`, { token: luis.token })
  const detenida = await hasta(() => sAna.cuenta('TRANSMISION_DETENIDA') > 0)
  comprobar('HU-11', 'detener: los compradores reciben TRANSMISION_DETENIDA ("Transmisión finalizada")', rStop.status === 200 && rStop.json?.transmitiendo === false && !!detenida, rStop.texto)
  const rFantasmaTx = await http('POST', '/api/streaming/subastas/00000000-0000-4000-8000-000000000000/iniciar', { token: luis.token })
  comprobar('HU-11', 'no se transmite en una subasta inexistente (404)', rFantasmaTx.status === 404, rFantasmaTx.texto)

  // ── HU-12 · Iniciar la subasta ─────────────────────────────────────────
  const rIniciarAjeno = await http('POST', `/api/subastas/${subasta}/iniciar`, { token: otro.token })
  comprobar('HU-12', 'otro Subastador no puede iniciarla (403)', rIniciarAjeno.status === 403, rIniciarAjeno.texto)
  const t0 = Date.now()
  const rIniciar = await http('POST', `/api/subastas/${subasta}/iniciar`, { token: luis.token })
  const duracion = rIniciar.json ? (Date.parse(rIniciar.json.horaFin) - Date.parse(rIniciar.json.horaInicio)) / 60000 : null
  comprobar('HU-12', 'el estado cambia a En curso y arranca el temporizador (hora de fin = inicio + 10 min)', rIniciar.status === 200 && rIniciar.json?.estado === 'EN_CURSO' && duracion === 10, rIniciar.texto)
  const iniciada = await hasta(() => sAna.ultimo('SUBASTA_INICIADA'))
  comprobar('HU-12', 'el inicio se difunde a los conectados (SUBASTA_INICIADA)', !!iniciada && iniciada.datos.precioBase === 100, JSON.stringify(iniciada))
  if (iniciada) console.log(`       (difusión del inicio en ${iniciada.en - t0} ms)`)
  const rIniciar2 = await http('POST', `/api/subastas/${subasta}/iniciar`, { token: luis.token })
  comprobar('HU-12', 'no se puede iniciar dos veces (409)', rIniciar2.status === 409, rIniciar2.texto)

  // ── HU-09 (bloqueo) y HU-10 (bloqueo) ──────────────────────────────────
  const rFichaBloq = await http('PUT', `/api/subastas/${subasta}/ficha`, { token: luis.token, cuerpo: ficha })
  comprobar('HU-09', 'edición bloqueada tras iniciar → 409 "La ficha no se puede editar con la subasta iniciada"', rFichaBloq.status === 409 && rFichaBloq.json?.mensaje === 'La ficha no se puede editar con la subasta iniciada', rFichaBloq.texto)
  const rReglasBloq = await http('PUT', `/api/subastas/${subasta}/reglas`, { token: luis.token, cuerpo: { duracionMinutos: 5, precioBase: 50, incrementoMinimo: 5 } })
  comprobar('HU-10', 'las reglas no cambian con la subasta iniciada (409)', rReglasBloq.status === 409, rReglasBloq.texto)

  // ── HU-13 · Puja rápida ────────────────────────────────────────────────
  const t1 = Date.now()
  sAna.enviar({ tipo: 'PUJAR', monto: 110 })
  const aceptadaBea = await hasta(() => sBea.ultimo('PUJA_ACEPTADA'))
  const aceptadaLuis = await hasta(() => sLuis.ultimo('PUJA_ACEPTADA'))
  comprobar('HU-13', 'puja rápida 110: precio pasa a 110 y Ana queda líder', !!aceptadaBea && aceptadaBea.datos.monto === 110 && aceptadaBea.datos.usuarioId === ana.id && aceptadaBea.datos.siguienteMinimo === 120, JSON.stringify(aceptadaBea))
  const latencia = aceptadaBea ? aceptadaBea.en - t1 : null
  comprobar('HU-13', `la puja se difunde a todos los conectados en menos de 1 s (${latencia} ms)`, !!aceptadaBea && !!aceptadaLuis && latencia < 1000, `latencia=${latencia}`)
  sAna.enviar({ tipo: 'PUJAR', monto: 120 })
  const rechazoLider = await hasta(() => sAna.ultimo('PUJA_RECHAZADA'))
  await esperar(400)
  comprobar('HU-13', 'siendo líder la puja se rechaza con "Vas ganando"', rechazoLider?.datos.mensaje === 'Vas ganando' && rechazoLider.datos.motivo === 'YA_ERES_LIDER', JSON.stringify(rechazoLider))
  comprobar('HU-14', 'el motivo del rechazo solo lo ve quien pujó', sBea.cuenta('PUJA_RECHAZADA') === 0 && sLuis.cuenta('PUJA_RECHAZADA') === 0)
  sLuis.enviar({ tipo: 'PUJAR', monto: 120 })
  const errorLuis = await hasta(() => sLuis.ultimo('ERROR'))
  comprobar('HU-13', 'el Subastador no puede pujar', errorLuis?.datos.mensaje === 'No autorizado', JSON.stringify(errorLuis))

  // ── HU-14 · Validar y registrar ────────────────────────────────────────
  sBea.enviar({ tipo: 'PUJAR', monto: 115 })
  const rechazoInc = await hasta(() => sBea.ultimo('PUJA_RECHAZADA'))
  comprobar('HU-14', 'puja por debajo del mínimo (115 con precio 110 + 10) → "No cumple el incremento mínimo"', rechazoInc?.datos.mensaje === 'No cumple el incremento mínimo' && rechazoInc.datos.motivo === 'INCREMENTO_MINIMO', JSON.stringify(rechazoInc))
  const rDirecta = await http('POST', `/api/subastas/${subasta}/pujas`, { token: bea.token, cuerpo: { monto: 105 } })
  comprobar('HU-14', 'por REST: 105 → 422 con motivo tipificado', rDirecta.status === 422 && rDirecta.json?.motivo === 'INCREMENTO_MINIMO' && rDirecta.json.aceptada === false, rDirecta.texto)
  sBea.enviar({ tipo: 'PUJAR', monto: 120 })
  const segunda = await hasta(() => sAna.mensajes.find((m) => m.tipo === 'PUJA_ACEPTADA' && m.datos.monto === 120))
  comprobar('HU-14', 'puja válida de 120: el líder se actualiza a Bea', segunda?.datos.usuarioId === bea.id && segunda.datos.cantidadPujas === 2, JSON.stringify(segunda))
  const rHist = await http('GET', `/api/subastas/${subasta}/pujas`, { token: ana.token })
  const h = rHist.json ?? []
  comprobar('HU-14', 'historial con usuario, monto y hora, consultable en orden', h.length === 2 && h[0].monto === 120 && h[0].usuarioId === bea.id && h[1].monto === 110 && h[1].usuarioId === ana.id && !!h[0].creadaEn && !!h[0].usuarioNombre, rHist.texto)
  const rDet = await http('GET', `/api/subastas/${subasta}`, { token: ana.token })
  comprobar('HU-14', 'el detalle refleja precio 120, líder Bea y 2 pujas', rDet.json?.precioActual === 120 && rDet.json.lider?.id === bea.id && rDet.json.cantidadPujas === 2, rDet.texto)
  const saldoTrasPujar = (await http('GET', '/api/orbes/saldo', { token: bea.token })).json?.saldo
  comprobar('HU-14', 'no se congelan Orbes al pujar (Bea conserva su saldo)', saldoTrasPujar === SALDO, `saldo=${saldoTrasPujar}`)

  // Saldo insuficiente: subasta con precio base por encima del saldo inicial.
  const rCara = await http('POST', '/api/subastas', { token: luis.token, cuerpo: { nombre: `Lote caro ${sufijo}`, descripcion: '', fechaInicio: enMinutos(30) } })
  const cara = rCara.json.id
  await http('PUT', `/api/subastas/${cara}/reglas`, { token: luis.token, cuerpo: { duracionMinutos: 10, precioBase: SALDO * 2, incrementoMinimo: 10 } })
  const sAnaCara = await sala(cara, ana.token)
  sAnaCara.enviar({ tipo: 'PUJAR', monto: SALDO * 2 + 10 })
  const noEnCurso = await hasta(() => sAnaCara.ultimo('PUJA_RECHAZADA'))
  comprobar('HU-12', 'antes de iniciar no se aceptan pujas ("La subasta no está en curso")', noEnCurso?.datos.motivo === 'SUBASTA_NO_EN_CURSO', JSON.stringify(noEnCurso))
  await http('POST', `/api/subastas/${cara}/iniciar`, { token: luis.token })
  await hasta(() => sAnaCara.ultimo('SUBASTA_INICIADA'))
  sAnaCara.mensajes.length = 0
  sAnaCara.enviar({ tipo: 'PUJAR', monto: SALDO * 2 + 10 })
  const sinSaldo = await hasta(() => sAnaCara.ultimo('PUJA_RECHAZADA'))
  comprobar('HU-13', 'saldo insuficiente: la puja se rechaza y muestra "Orbes insuficientes"', sinSaldo?.datos.mensaje === 'Orbes insuficientes', JSON.stringify(sinSaldo))
  const rCaraDet = await http('GET', `/api/subastas/${cara}`, { token: ana.token })
  comprobar('HU-14', 'puja sin saldo: motivo tipificado y no cambia el líder', sinSaldo?.datos.motivo === 'SALDO_INSUFICIENTE' && rCaraDet.json?.lider === null && rCaraDet.json.cantidadPujas === 0, rCaraDet.texto)
  sAnaCara.cerrar()

  // ── HU-04 con la subasta En curso y HU-05 al salir ─────────────────────
  const rLista2 = await http('GET', '/api/subastas?estado=programada,en_curso', { token: ana.token })
  comprobar('HU-04', 'la subasta En curso sigue en el listado con su precio actual', rLista2.json?.find((s) => s.id === subasta)?.estado === 'EN_CURSO' && rLista2.json.find((s) => s.id === subasta).precioActual === 120, rLista2.texto.slice(0, 300))
  sBea.cerrar()
  const vuelveADos = await hasta(() => sAna.ultimo('CONECTADOS')?.datos.conectados === 2)
  comprobar('HU-05', 'al salir de la sala se libera la conexión (vuelve a 2)', !!vuelveADos, JSON.stringify(sAna.ultimo('CONECTADOS')))
  sAna.cerrar()
  sLuis.cerrar()

  // ── Resumen ────────────────────────────────────────────────────────────
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
