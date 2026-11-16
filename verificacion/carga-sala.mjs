// Prueba de carga de una sala: N compradores conectados a la misma subasta, pujando por turnos.
// Mide cuánto tarda en entrar toda la sala, cuánto tarda una puja en llegar a todos y cuántas conexiones se caen.
//
//   node carga-sala.mjs                       100 compradores contra el backend local
//   COMPRADORES=300 PUJAS=40 node carga-sala.mjs
//   API_URL=https://... WS_URL=wss://... COMPRADORES=100 node carga-sala.mjs
//
// REN-01 ya NO se mide con este script: su modo sostenido podía dar falsos aprobados (no exigía la carga completa
// ni que cada puja aceptada llegara a todos los compradores). El generador oficial es ren01/carga-sala.mjs y el
// dictamen lo da ren01/evidencia-ren01/certificar.mjs.
// Las sesiones las firma sesiones-de-prueba.mjs: hacen falta JWT_SECRET y BROKER_* del ambiente (ver ese archivo).
//
// Crea usuarios y una subasta de prueba con un sufijo único; la subasta dura DURACION_MIN minutos y cierra sola.
// Contra QA deja datos de prueba y cobra al ganador de mentira: no usar en producción.
import { sesionDePrueba } from './sesiones-de-prueba.mjs'
const API = process.env.API_URL ?? 'http://localhost:8080'
const WS = process.env.WS_URL ?? 'ws://localhost:8085'
const COMPRADORES = Number(process.env.COMPRADORES ?? 100)
const PUJAS = Number(process.env.PUJAS ?? 20)
const DURACION_MIN = Number(process.env.DURACION_MIN ?? 5)
/** Cuántas sesiones y conexiones se abren a la vez: simula a la gente entrando en oleadas, no una por una. */
const OLEADA = Number(process.env.OLEADA ?? 25)
const MODO = process.env.MODO ?? 'turnos'
const PUJAS_POR_SEG = Number(process.env.PUJAS_POR_SEG ?? 20)
const SOSTENIDA_MIN = Number(process.env.SOSTENIDA_MIN ?? 10)
const sufijo = Date.now().toString(36)

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

async function http(metodo, ruta, { token, cuerpo } = {}) {
  const headers = {}
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(API + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) })
  const texto = await r.text()
  let json = null
  try { json = texto ? JSON.parse(texto) : null } catch { /* no es JSON */ }
  if (!r.ok) throw new Error(`${metodo} ${ruta} → HTTP ${r.status} ${texto.slice(0, 120)}`)
  return json
}

async function hasta(fn, ms, paso = 100) {
  const fin = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > fin) return false
    await esperar(paso)
  }
}

/** Ejecuta las tareas de a `tamano` en paralelo y devuelve los resultados en orden. */
async function enOleadas(elementos, tamano, tarea) {
  const resultados = []
  for (let i = 0; i < elementos.length; i += tamano) {
    resultados.push(...(await Promise.all(elementos.slice(i, i + tamano).map(tarea))))
  }
  return resultados
}

async function sesion(nombre, rol) {
  // SEG-01: no hay login propio; la sesión la firma la herramienta del operador (sesiones-de-prueba.mjs).
  const r = await sesionDePrueba(nombre, rol)
  return { token: r.token, id: r.usuario.id, nombre }
}

/** Abre la conexión de un comprador a la sala y anota cuándo recibe cada puja. */
async function conectar(subastaId, usuario) {
  // SEG-04: la URL lleva un ticket de un solo uso, nunca el token de sesión.
  const { ticket } = await http('POST', '/api/sesion/ticket-ws', { token: usuario.token })
  return new Promise((resolver) => {
    const inicio = Date.now()
    const ws = new WebSocket(`${WS}/ws/salas/${subastaId}?ticket=${encodeURIComponent(ticket)}`)
    const c = { usuario, ws, abierta: false, tardoEnAbrir: null, caidas: 0, conectados: 0, pujas: new Map(), rechazos: 0,
      errores: 0, aceptadas: [], ganadorDe: new Map() }
    c.enviar = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
    ws.onopen = () => {
      c.abierta = true
      c.tardoEnAbrir = Date.now() - inicio
      // El mismo latido que envía el navegador, para que la conexión no se cierre por inactividad.
      c.latido = setInterval(() => c.enviar({ tipo: 'PING' }), 15_000)
      resolver(c)
    }
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.tipo === 'CONECTADOS') c.conectados = m.datos.conectados
      if (m.tipo === 'PUJA_ACEPTADA') {
        c.pujas.set(m.datos.monto, Date.now())
        c.aceptadas.push(m.datos.monto)
        c.ganadorDe.set(m.datos.monto, m.datos.usuarioId)
      }
      if (m.tipo === 'PUJA_RECHAZADA' || m.tipo === 'ERROR') c.rechazos++
      if (m.tipo === 'ERROR') c.errores++
    }
    ws.onclose = () => {
      clearInterval(c.latido)
      if (c.abierta) c.caidas++
      c.abierta = false
      resolver(c)
    }
    ws.onerror = () => resolver(c)
  })
}

function percentil(valores, p) {
  if (valores.length === 0) return null
  const orden = [...valores].sort((a, b) => a - b)
  return orden[Math.min(orden.length - 1, Math.ceil((p / 100) * orden.length) - 1)]
}

const ms = (v) => (v === null ? '—' : `${Math.round(v)} ms`)

async function main() {
  if (MODO === 'sostenida') {
    console.error('MODO=sostenida está retirado: puede dar falsos aprobados de REN-01. Usa ren01/carga-sala.mjs y certifica con ren01/evidencia-ren01/certificar.mjs.')
    process.exit(2)
  }
  console.log(`Sala con ${COMPRADORES} compradores y ${PUJAS} pujas · ${API} · ${WS}\n`)

  // ── Preparación ────────────────────────────────────────────────────────
  const luis = await sesion(`Carga Luis ${sufijo}`, 'SUBASTADOR')
  const subasta = (await http('POST', '/api/subastas', {
    token: luis.token,
    cuerpo: { nombre: `Carga ${sufijo}`, descripcion: 'Prueba de carga', fechaInicio: new Date(Date.now() + 30 * 60_000).toISOString() },
  })).id
  // En modo sostenido la subasta debe durar más que la prueba, para que no cierre a mitad de la medición.
  const duracion = MODO === 'sostenida' ? Math.max(DURACION_MIN, SOSTENIDA_MIN + 2) : DURACION_MIN
  await http('PUT', `/api/subastas/${subasta}/reglas`, { token: luis.token, cuerpo: { duracionMinutos: duracion, precioBase: 100, incrementoMinimo: 10 } })

  let t = Date.now()
  const compradores = await enOleadas([...Array(COMPRADORES).keys()], OLEADA, (i) => sesion(`Carga ${sufijo} ${i}`, 'COMPRADOR'))
  console.log(`Sesiones creadas:        ${COMPRADORES} en ${((Date.now() - t) / 1000).toFixed(1)} s`)
  // La carga inicial de Orbes llega por evento: se espera a que el último comprador la tenga.
  const conSaldo = await hasta(async () => (await http('GET', '/api/orbes/saldo', { token: compradores.at(-1).token })).saldo > 0, 30_000, 500)
  if (!conSaldo) console.log('AVISO: el último comprador aún no tiene saldo; sus pujas serán rechazadas')

  // ── Entrada a la sala ──────────────────────────────────────────────────
  t = Date.now()
  const salas = await enOleadas(compradores, OLEADA, (c) => conectar(subasta, c))
  const entraron = salas.filter((s) => s.abierta)
  const tiemposDeEntrada = entraron.map((s) => s.tardoEnAbrir)
  console.log(`Conexiones abiertas:     ${entraron.length} de ${COMPRADORES} en ${((Date.now() - t) / 1000).toFixed(1)} s`)
  console.log(`Tiempo en conectar:      mediana ${ms(percentil(tiemposDeEntrada, 50))} · p95 ${ms(percentil(tiemposDeEntrada, 95))} · máximo ${ms(percentil(tiemposDeEntrada, 100))}`)

  t = Date.now()
  const conteoCorrecto = await hasta(() => entraron.every((s) => s.conectados === entraron.length), 15_000)
  console.log(`Conteo de conectados:    ${conteoCorrecto ? `todos ven ${entraron.length} tras ${((Date.now() - t) / 1000).toFixed(1)} s` : `NO converge (algunos ven ${[...new Set(entraron.map((s) => s.conectados))].join(', ')})`}`)

  if (MODO === 'sostenida') {
    // Inalcanzable: main() rechaza MODO=sostenida antes de crear datos. Se conserva solo como referencia histórica.
    await http('POST', `/api/subastas/${subasta}/iniciar`, { token: luis.token })
    await esperar(1000)
    const aprobada = await cargaSostenida(entraron, salas)
    salas.forEach((s) => { clearInterval(s.latido); s.ws.close() })
    process.exit(aprobada ? 0 : 1)
  }

  // ── Pujas ──────────────────────────────────────────────────────────────
  await http('POST', `/api/subastas/${subasta}/iniciar`, { token: luis.token })
  await esperar(1000)
  const demoras = []
  let pujasCompletas = 0
  for (let i = 0; i < PUJAS; i++) {
    const monto = 110 + i * 10
    // El que puja no puede ser el líder: se van turnando.
    const quien = entraron[i % entraron.length]
    const enviadaEn = Date.now()
    quien.enviar({ tipo: 'PUJAR', monto })
    const llegoATodos = await hasta(() => entraron.every((s) => !s.abierta || s.pujas.has(monto)), 10_000, 20)
    if (llegoATodos) pujasCompletas++
    for (const s of entraron) if (s.pujas.has(monto)) demoras.push(s.pujas.get(monto) - enviadaEn)
  }
  const esperadas = PUJAS * entraron.length
  console.log(`Pujas que llegan a toda la sala: ${pujasCompletas} de ${PUJAS}`)
  console.log(`Avisos de puja entregados:       ${demoras.length} de ${esperadas} (${((100 * demoras.length) / esperadas).toFixed(1)} %)`)
  console.log(`Demora puja → pantalla:  mediana ${ms(percentil(demoras, 50))} · p95 ${ms(percentil(demoras, 95))} · máximo ${ms(percentil(demoras, 100))}`)

  // ── Estabilidad ────────────────────────────────────────────────────────
  await esperar(20_000)
  const caidas = salas.reduce((n, s) => n + s.caidas, 0)
  const rechazos = salas.reduce((n, s) => n + s.rechazos, 0)
  console.log(`Conexiones caídas:       ${caidas}`)
  console.log(`Pujas rechazadas:        ${rechazos}`)

  salas.forEach((s) => { clearInterval(s.latido); s.ws.close() })

  // El backlog pide que una puja se difunda a todos en menos de 1 s (HU-13).
  const p95 = percentil(demoras, 95)
  const aprobada = entraron.length === COMPRADORES && conteoCorrecto && pujasCompletas === PUJAS && caidas === 0 && p95 !== null && p95 < 1000
  console.log(`\n${aprobada ? 'APROBADA' : 'CON OBSERVACIONES'}: ${entraron.length}/${COMPRADORES} conectados, ${pujasCompletas}/${PUJAS} pujas completas, ${caidas} caídas, p95 ${ms(p95)}`)
  console.log(`La subasta "Carga ${sufijo}" cierra sola en ${DURACION_MIN} min y cobra a quien quedó líder.`)
  process.exit(aprobada ? 0 : 1)
}

/**
 * REN-01: cada 1000/PUJAS_POR_SEG ms un comprador al azar (que no sea el líder) puja el precio actual más el
 * incremento. Mientras el evento de la puja anterior no llega, varios compiten por el mismo monto: exactamente uno
 * debe ganar cada incremento. Mide la latencia de envío a llegada en todas las conexiones.
 */
async function cargaSostenida(entraron, salas) {
  const observador = entraron[0]
  const envios = new Map() // `${usuarioId}:${monto}` → instante de envío
  let enviadas = 0
  const fin = Date.now() + SOSTENIDA_MIN * 60_000
  const intervalo = 1000 / PUJAS_POR_SEG
  console.log(`\nCarga sostenida: ${PUJAS_POR_SEG} pujas/s durante ${SOSTENIDA_MIN} min sobre ${entraron.length} conexiones`)

  let siguiente = Date.now()
  while (Date.now() < fin) {
    const ultimo = observador.aceptadas.at(-1) ?? 100
    const lider = observador.ganadorDe.get(ultimo)
    const candidatos = entraron.filter((s) => s.abierta && s.usuario.id !== lider)
    const quien = candidatos[Math.floor(Math.random() * candidatos.length)]
    if (quien) {
      const monto = ultimo + 10
      envios.set(`${quien.usuario.id}:${monto}`, Date.now())
      quien.enviar({ tipo: 'PUJAR', monto })
      enviadas++
    }
    siguiente += intervalo
    await esperar(Math.max(0, siguiente - Date.now()))
  }
  await esperar(5000)

  // Latencia de envío a llegada, en cada conexión, de cada puja ganadora.
  const demoras = []
  for (const s of entraron) {
    for (const [monto, llegada] of s.pujas) {
      const enviada = envios.get(`${observador.ganadorDe.get(monto)}:${monto}`)
      if (enviada !== undefined) demoras.push(llegada - enviada)
    }
  }
  // Exactamente una puja gana cada incremento, sin duplicados y en orden en cada conexión.
  const duplicadas = entraron.reduce((n, s) => n + (s.aceptadas.length - new Set(s.aceptadas).size), 0)
  const fueraDeOrden = entraron.filter((s) => s.aceptadas.some((m, i) => i > 0 && m <= s.aceptadas[i - 1])).length
  const ganadas = new Set(observador.aceptadas).size
  const caidas = salas.reduce((n, s) => n + s.caidas, 0)
  const errores = salas.reduce((n, s) => n + s.errores, 0)
  const p95 = percentil(demoras, 95)
  const p99 = percentil(demoras, 99)
  const tasaErrores = enviadas === 0 ? 0 : errores / enviadas

  console.log(`Pujas enviadas:          ${enviadas} (${(enviadas / (SOSTENIDA_MIN * 60)).toFixed(1)} por segundo)`)
  console.log(`Incrementos ganados:     ${ganadas} (exactamente una ganadora por incremento)`)
  console.log(`Duplicadas / fuera de orden: ${duplicadas} / ${fueraDeOrden} conexiones`)
  console.log(`Latencia envío → llegada: p95 ${ms(p95)} · p99 ${ms(p99)} · máximo ${ms(percentil(demoras, 100))}`)
  console.log(`Errores (no rechazos):   ${errores} (${(100 * tasaErrores).toFixed(2)} %)`)
  console.log(`Conexiones caídas:       ${caidas}`)

  const aprobada = p95 !== null && p95 <= 800 && p99 <= 1500 && caidas === 0 && duplicadas === 0 && fueraDeOrden === 0
    && tasaErrores < 0.01
  console.log(`\n${aprobada ? 'REN-01 APROBADO' : 'REN-01 CON OBSERVACIONES'} · revisa además la CPU por réplica (< 80 %) en Azure Monitor`)
  return aprobada
}

main().catch((e) => {
  console.error('La prueba no pudo completarse:', e.message)
  process.exit(2)
})
