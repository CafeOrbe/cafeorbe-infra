// Verificación en QA de los tres escenarios de seguridad aprobados: SEG-01 (autenticación con Google),
// SEG-02 (autorización) y SEG-03 (resistencia a abuso), con las medidas de respuesta del documento.
//
//   API_URL=https://api-gateway.<qa>.azurecontainerapps.io WS_URL=wss://realtime-gateway.<qa>.azurecontainerapps.io \
//   SIN_REGISTRO=1 JWT_SECRET=... [INTERNAL_TOKEN=...] node seguridad-qa.mjs
//
// SIN_REGISTRO=1: solo hace falta JWT_SECRET; no se publica nada en el broker y las personas de prueba quedan sin
// Orbes (sus pujas se rechazan por saldo, lo que igual sirve para medir tiempos y comprobar el límite).
// INTERNAL_TOKEN (opcional): lee /actuator/prometheus de cada servicio para los p95 de SEG-01 (< 3 s) y SEG-02
// (< 5 ms). Sin él, esas dos medidas se toman del tablero de Grafana.
//
// Crea usuarios y una subasta que cierra sola en 5 minutos en QA y 3 minutos en PROD.
// Los abusadores quedan bloqueados 60 s en el realtime: son personas de prueba nuevas en cada corrida.
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto'
import { sesionDePrueba } from './sesiones-de-prueba.mjs'

const API = process.env.API_URL ?? 'http://localhost:8080'
const WS = process.env.WS_URL ?? 'ws://localhost:8085'
const AMBIENTE = process.env.CAFEORBE_AMBIENTE
if (AMBIENTE && !['qa', 'prod'].includes(AMBIENTE)) throw new Error('CAFEORBE_AMBIENTE debe ser qa o prod')
if (AMBIENTE === 'prod' && (
  API !== 'https://cafeorbe-lb.eastus2.cloudapp.azure.com' ||
  WS !== 'wss://cafeorbe-lb.eastus2.cloudapp.azure.com'
)) throw new Error('La prueba de seguridad en PROD requiere las URL del balanceador')
const DURACION_MINUTOS = AMBIENTE === 'prod' ? 3 : 5
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '913806154996-u2kknfknc1lv5bg6qrmtsa34ioc9jg2t.apps.googleusercontent.com'
const sufijo = Date.now().toString(36)
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))
const MUESTRAS_LEGITIMAS = Number(process.env.MUESTRAS ?? 30)

let fallas = 0
function comprobar(nombre, ok, detalle = '') {
  if (!ok) fallas++
  console.log(`${ok ? '✔' : '✘'} ${nombre}${detalle ? ` · ${detalle}` : ''}`)
}
const percentil = (valores, p) => {
  const orden = [...valores].sort((a, b) => a - b)
  return orden.length ? orden[Math.min(orden.length - 1, Math.ceil((p / 100) * orden.length) - 1)] : null
}

async function llamar(metodo, ruta, { token, cuerpo, cabeceras = {}, base = API } = {}) {
  const headers = { ...cabeceras }
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(base + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) })
  const texto = await r.text()
  let json = null
  try { json = texto ? JSON.parse(texto) : null } catch { /* no es JSON */ }
  return { estado: r.status, json, texto, cabeceras: r.headers }
}

async function exigirOk(metodo, ruta, opciones) {
  const r = await llamar(metodo, ruta, opciones)
  if (r.estado >= 300) throw new Error(`${metodo} ${ruta} → HTTP ${r.estado} ${r.texto.slice(0, 150)}`)
  return r.json
}

async function sesion(nombre, rol) {
  const r = await sesionDePrueba(`${nombre} ${sufijo}`, rol)
  return { token: r.token, id: r.usuario.id, rol }
}

/** Abre la sala y guarda cada mensaje (con su hora de llegada) y el código de cierre. */
async function abrirSala(subastaId, usuario) {
  const { ticket } = await exigirOk('POST', '/api/sesion/ticket-ws', { token: usuario.token })
  return new Promise((resolver, rechazar) => {
    const ws = new WebSocket(`${WS}/ws/salas/${subastaId}?ticket=${encodeURIComponent(ticket)}`)
    const sala = { ws, mensajes: [], cierre: null, cerradaEn: null, abierta: false }
    sala.enviar = (m) => ws.readyState === WebSocket.OPEN && ws.send(typeof m === 'string' ? m : JSON.stringify(m))
    ws.onopen = () => { sala.abierta = true; resolver(sala) }
    ws.onmessage = (e) => sala.mensajes.push({ ...JSON.parse(e.data), llegoEn: Date.now() })
    ws.onclose = (e) => { sala.abierta = false; sala.cierre = e.code; sala.cerradaEn = Date.now(); resolver(sala) }
    ws.onerror = () => rechazar(new Error('handshake rechazado'))
  })
}

const respuestasDePuja = (sala) => sala.mensajes.filter((m) => m.tipo === 'PUJA_ACEPTADA' || m.tipo === 'PUJA_RECHAZADA'
  || (m.tipo === 'ERROR' && m.datos?.motivo !== 'LIMITE_DE_PUJAS'))

/** Cuánto tarda cada puja de la compradora legítima en tener respuesta (pujas de a una, 4 por segundo). */
async function medirPujas(sala, cantidad, montoInicial) {
  const tiempos = []
  for (let i = 0; i < cantidad; i++) {
    const antes = respuestasDePuja(sala).length
    const enviada = Date.now()
    sala.enviar({ tipo: 'PUJAR', monto: montoInicial + i * 10 })
    while (respuestasDePuja(sala).length === antes && Date.now() - enviada < 5000) await esperar(5)
    tiempos.push(Date.now() - enviada)
    await esperar(250)
  }
  return tiempos
}

// ── Métricas de /actuator/prometheus (solo con INTERNAL_TOKEN) ────────────────────────────────────────
const PUERTOS_LOCALES = { 'api-gateway': 8080, 'identity-service': 8081, 'auction-service': 8082, 'wallet-service': 8083,
  'streaming-service': 8084, 'realtime-gateway': 8085 }
/** Usa el ingreso directo para comprobar la protección de cada servicio y leer sus métricas. */
function urlDe(servicio) {
  if (AMBIENTE === 'prod') return `https://${servicio}-prod.thankfulmoss-4f48ec41.eastus2.azurecontainerapps.io`
  if (AMBIENTE === 'qa') return `https://${servicio}.blackbay-48700ead.eastus2.azurecontainerapps.io`
  return API.includes('api-gateway')
    ? API.replace('api-gateway', servicio)
    : API.replace(/:\d+$/, `:${PUERTOS_LOCALES[servicio]}`)
}
async function metricas(servicio) {
  const r = await fetch(`${urlDe(servicio)}/actuator/prometheus`, { headers: { 'X-Internal-Token': INTERNAL_TOKEN } })
  if (!r.ok) throw new Error(`${servicio}: HTTP ${r.status} al leer /actuator/prometheus (¿INTERNAL_TOKEN correcto?)`)
  return r.text()
}
/** Suma los buckets de un histograma que cumplen el filtro: devuelve {dentro, total} para el umbral dado. */
function fraccionBajo(texto, nombre, filtro, umbral) {
  let dentro = 0, total = 0
  for (const linea of texto.split('\n')) {
    if (!linea.startsWith(`${nombre}_bucket{`) || !filtro(linea)) continue
    const valor = Number(linea.slice(linea.lastIndexOf(' ') + 1))
    const le = linea.match(/le="([^"]+)"/)?.[1]
    if (le === '+Inf') total += valor
    else if (Number(le) === umbral) dentro += valor
  }
  return { dentro, total }
}

// ── SEG-01 ───────────────────────────────────────────────────────────────────────────────────────────
async function seg01() {
  console.log('SEG-01 · Autenticación con Google')
  const b = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
  const ahora = Math.floor(Date.now() / 1000)
  const reclamos = { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, sub: '1234567890', email: 'atacante@gmail.com',
    email_verified: true, name: 'Atacante', iat: ahora, exp: ahora + 3600 }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rs = (c, kid = 'kid-inventado') => {
    const h = b({ alg: 'RS256', kid, typ: 'JWT' }), p = b(c)
    return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url')}`
  }
  const hs = (() => { const h = b({ alg: 'HS256' }), p = b(reclamos); return `${h}.${p}.${createHmac('sha256', 'x').update(`${h}.${p}`).digest('base64url')}` })()
  const alterado = (() => { const t = rs(reclamos).split('.'); t[1] = b({ ...reclamos, email: 'admin@cafeorbe.com' }); return t.join('.') })()
  const casos = [
    ['texto cualquiera', 'esto-no-es-un-token'], ['JWT sin firma (alg none)', `${b({ alg: 'none' })}.${b(reclamos)}.`],
    ['HS256 con clave inventada', hs], ['RS256 firmado con una llave que no es de Google', rs(reclamos)],
    ['kid de Google inventado', rs(reclamos, 'a1b2c3')], ['vencido', rs({ ...reclamos, iat: ahora - 7200, exp: ahora - 3600 })],
    ['emitido para otra aplicación (aud)', rs({ ...reclamos, aud: '111-otra.apps.googleusercontent.com' })],
    ['emisor que no es Google (iss)', rs({ ...reclamos, iss: 'https://evil.example' })], ['contenido alterado', alterado],
    ['correo sin verificar', rs({ ...reclamos, email_verified: false })], ['firma truncada', rs(reclamos).slice(0, -20)],
  ]
  const rechazos = []
  for (const [nombre, idToken] of casos) {
    const r = await llamar('POST', '/api/sesion/google', { cuerpo: { idToken, rol: 'COMPRADOR' } })
    rechazos.push({ nombre, estado: r.estado, sinSesion: !/"token"\s*:/.test(r.texto) })
  }
  const malos = rechazos.filter((r) => r.estado !== 401 || !r.sinSesion)
  comprobar(`${casos.length} ID tokens falsos, alterados, vencidos o de otra app → 401 sin crear sesión`, malos.length === 0,
    malos.length ? malos.map((m) => `${m.nombre}: ${m.estado}`).join(', ') : `${casos.length}/${casos.length}`)
  const nombre = await llamar('POST', '/api/sesion', { cuerpo: { nombre: 'Atacante', rol: 'COMPRADOR' } })
  comprobar('No existe login propio: POST /api/sesion por nombre no crea sesión', nombre.estado >= 400 && !/"token"\s*:/.test(nombre.texto),
    `HTTP ${nombre.estado}`)
}

// ── SEG-02 ───────────────────────────────────────────────────────────────────────────────────────────
async function seg02(gente, subasta, reglas) {
  const { luis, otroSubastador, cata } = gente
  console.log('\nSEG-02 · Autorización (matriz de casos negativos)')
  const foto = async () => {
    const d = await exigirOk('GET', `/api/subastas/${subasta}`, { token: luis.token })
    return JSON.stringify({ estado: d.estado, nombre: d.nombre, reglas: d.reglas, ficha: d.ficha, fechaInicio: d.fechaInicio, subastador: d.subastadorId })
  }
  const antes = await foto()
  const misAntes = (await exigirOk('GET', '/api/subastas/mias', { token: luis.token })).length
  const futura = () => new Date(Date.now() + 3_600_000).toISOString()
  const casos = [
    ['Comprador crea una subasta', 'POST', '/api/subastas', cata, { nombre: 'x', descripcion: 'x', fechaInicio: futura() }],
    ['Comprador lista "mis subastas" de Subastador', 'GET', '/api/subastas/mias', cata],
    ['Comprador inicia una subasta', 'POST', `/api/subastas/${subasta}/iniciar`, cata],
    ['Comprador cambia las reglas', 'PUT', `/api/subastas/${subasta}/reglas`, cata, { ...reglas, precioBase: 1 }],
    ['Otro Subastador cambia las reglas de una subasta ajena', 'PUT', `/api/subastas/${subasta}/reglas`, otroSubastador, { ...reglas, precioBase: 1 }],
    ['Otro Subastador inicia una subasta ajena', 'POST', `/api/subastas/${subasta}/iniciar`, otroSubastador],
    ['Comprador inicia la transmisión', 'POST', `/api/streaming/subastas/${subasta}/iniciar`, cata],
    ['Otro Subastador transmite una subasta ajena', 'POST', `/api/streaming/subastas/${subasta}/iniciar`, otroSubastador],
    ['Comprador con X-User-Rol: SUBASTADOR inventada crea una subasta', 'POST', '/api/subastas', cata,
      { nombre: 'x', descripcion: 'x', fechaInicio: futura() }, { 'X-User-Id': luis.id, 'X-User-Rol': 'SUBASTADOR', 'X-Internal-Token': 'inventado' }],
  ]
  const directos = [
    ['wallet /internal/orbes/{id}/saldo directo, sin credencial', 'wallet-service', `/internal/orbes/${cata.id}/saldo`],
    ['wallet /internal directo con X-User-* inventadas', 'wallet-service', `/internal/orbes/${cata.id}/saldo`, { 'X-User-Id': cata.id, 'X-User-Rol': 'COMPRADOR' }],
    ['auction /api/subastas directo, sin credencial interna', 'auction-service', '/api/subastas', { 'X-User-Id': luis.id, 'X-User-Rol': 'SUBASTADOR' }],
    ['wallet directo con X-Internal-Token falso', 'wallet-service', `/internal/orbes/${cata.id}/saldo`, { 'X-Internal-Token': 'falso' }],
  ]
  let negativos = 0, correctos = 0
  for (const [nombre, metodo, ruta, quien, cuerpo, cabeceras] of casos) {
    const r = await llamar(metodo, ruta, { token: quien.token, cuerpo, cabeceras })
    negativos++; if (r.estado === 403) correctos++
    comprobar(`${nombre} → 403`, r.estado === 403, `HTTP ${r.estado}`)
  }
  for (const [nombre, servicio, ruta, cabeceras] of directos) {
    const r = await llamar('GET', ruta, { base: urlDe(servicio), cabeceras })
    negativos++; if (r.estado === 403) correctos++
    comprobar(`${nombre} → 403`, r.estado === 403, `HTTP ${r.estado}`)
  }
  const porGateway = await llamar('GET', `/internal/orbes/${cata.id}/saldo`, { token: cata.token })
  comprobar('El gateway no expone /internal', porGateway.estado === 404 || porGateway.estado === 403, `HTTP ${porGateway.estado}`)
  comprobar(`Matriz: ${correctos}/${negativos} casos negativos con 403 (meta: 100 % de 10 o más)`, negativos >= 10 && correctos === negativos)
  comprobar('Ningún caso negativo cambió datos: la subasta sigue igual y no se creó ninguna', (await foto()) === antes
    && (await exigirOk('GET', '/api/subastas/mias', { token: luis.token })).length === misAntes)
  comprobar('Casos legítimos: el Subastador dueño lista sus subastas → 200', (await llamar('GET', '/api/subastas/mias', { token: luis.token })).estado === 200)
  comprobar('Casos legítimos: el Comprador consulta su saldo → 200', (await llamar('GET', '/api/orbes/saldo', { token: cata.token })).estado === 200)
}

// ── SEG-03 ───────────────────────────────────────────────────────────────────────────────────────────
async function seg03(gente, subasta) {
  const { cata, abusadores, atacantes } = gente
  console.log('\nSEG-03 · Resistencia a abuso')

  // Línea base: la compradora legítima puja sin que nadie ataque. 30 muestras por fase: con 20, el p95 es casi el
  // máximo y la variación de la red desde fuera de Azure decide el resultado.
  const salaCata = await abrirSala(subasta, cata)
  await esperar(500)
  const base = await medirPujas(salaCata, MUESTRAS_LEGITIMAS, 1000)

  // Ataque sostenido durante TODA la segunda medición: cada atacante manda PUJAR a 30 por segundo y queda bloqueado
  // en ~1 s, así que entra uno nuevo cada 1,5 s mientras ella sigue pujando.
  let midiendo = true
  const ataques = atacantes.map(async (atacante, n) => {
    await esperar(n * 1500)
    if (!midiendo) return null
    const sala = await abrirSala(subasta, atacante)
    const inicio = Date.now()
    if (n === 0) {
      // SEG-03: "la infracción aparece en el tablero en 15 s o menos". Con esta hora se compara cuándo sube el panel.
      const hora = new Date(inicio).toLocaleTimeString('es-CO', { hour12: false })
      console.log(`  ⏱ Ataque iniciado a las ${hora} (hora local): mira cuándo sube "Infracciones" en el tablero técnico`)
    }
    let enviados = 0
    for (let i = 0; i < 30 && sala.abierta; i++) { sala.enviar({ tipo: 'PUJAR', monto: 5000 + i * 10 }); enviados++; await esperar(33) }
    await esperar(4000)
    return { sala, inicio, enviados }
  })
  const duranteAtaque = await medirPujas(salaCata, MUESTRAS_LEGITIMAS, 2000)
  midiendo = false
  const resultados = (await Promise.all(ataques)).filter(Boolean)

  const limite = resultados.reduce((s, r) => s + r.sala.mensajes.filter((m) => m.datos?.motivo === 'LIMITE_DE_PUJAS').length, 0)
  comprobar('Ráfagas de 30 PUJAR/s → el excedente recibe ERROR con motivo LIMITE_DE_PUJAS', limite > 0,
    `${limite} avisos en ${resultados.length} atacantes durante la medición`)
  const cierres = resultados.map((r) => r.sala.cierre === 4429 ? `4429 a los ${((r.sala.cerradaEn - r.inicio) / 1000).toFixed(1)} s` : `${r.sala.cierre ?? 'abierta'}`)
  comprobar('Tras 3 infracciones en 1 min el usuario queda bloqueado (cierre 4429)', resultados.every((r) => r.sala.cierre === 4429), cierres.join(' · '))
  // Lo que llegó a auction recibe respuesta (aceptada o rechazada por saldo). El límite deja pasar 10 por segundo
  // de reloj (ventana fija): una ráfaga de 0,7 s que cruza el cambio de segundo puede pasar 10 en cada uno.
  // "Sobre el límite" es todo lo enviado que no corresponde a ese cupo; de eso, lo que llegó a auction es lo que
  // supera el cupo entre las respuestas recibidas.
  let sobreLimite = 0, sobreLimiteQueLlego = 0
  for (const r of resultados) {
    const llegaron = respuestasDePuja(r.sala).length
    const ventanas = Math.floor((r.sala.cerradaEn ?? Date.now()) / 1000) - Math.floor(r.inicio / 1000) + 1
    const cupo = 10 * ventanas
    sobreLimite += r.enviados - Math.min(llegaron, cupo)
    sobreLimiteQueLlego += Math.max(0, llegaron - cupo)
  }
  const bloqueados = sobreLimite === 0 ? 100 : (100 * (sobreLimite - sobreLimiteQueLlego)) / sobreLimite
  comprobar('≥ 99 % de los mensajes sobre el límite no llega a auction', bloqueados >= 99,
    `${sobreLimite - sobreLimiteQueLlego} de ${sobreLimite} detenidos (${bloqueados.toFixed(1)} %)`)

  let reconexion
  try {
    const nueva = await abrirSala(subasta, atacantes[0])
    await esperar(1500)
    reconexion = nueva.cierre === 4429 ? 'cerrada con 4429' : nueva.abierta ? 'abierta' : `cierre ${nueva.cierre}`
    nueva.ws.close()
  } catch (e) {
    reconexion = `rechazada en el handshake (${e.message})`
  }
  comprobar('El usuario bloqueado no puede volver a entrar durante los 60 s', reconexion !== 'abierta', reconexion)

  const p95Base = percentil(base, 95), p95Ataque = percentil(duranteAtaque, 95)
  const empeora = (100 * (p95Ataque - p95Base)) / p95Base
  comprobar('El p95 de la compradora legítima empeora menos de 20 % durante el ataque', empeora < 20,
    `p95 sin ataque ${p95Base} ms · con ataque ${p95Ataque} ms (${empeora >= 0 ? '+' : ''}${empeora.toFixed(1)} %)`)
  comprobar('La compradora legítima sigue conectada', salaCata.abierta, salaCata.abierta ? '' : `cierre ${salaCata.cierre}`)
  salaCata.ws.close()

  // Más de 5 conexiones del mismo usuario.
  const varias = abusadores[3]
  const abiertas = []
  for (let i = 0; i < 5; i++) abiertas.push(await abrirSala(subasta, varias))
  let sexta
  try { const s = await abrirSala(subasta, varias); sexta = s.abierta ? 'abierta' : `cierre ${s.cierre}`; s.ws.close() } catch (e) { sexta = 'rechazada en el handshake' }
  comprobar('La sexta conexión simultánea del mismo usuario se rechaza', sexta !== 'abierta', `5 abiertas, la 6.ª ${sexta}`)
  abiertas.forEach((s) => s.ws.close())

  // Mensajes de más de 1 KB.
  await esperar(1500)
  const grande = await abrirSala(subasta, abusadores[4])
  grande.enviar(JSON.stringify({ tipo: 'PUJAR', monto: 9000, relleno: 'x'.repeat(2000) }))
  await esperar(2000)
  comprobar('Un mensaje de más de 1 KB cierra la conexión con 1009 sin llegar a auction', grande.cierre === 1009 && respuestasDePuja(grande).length === 0,
    `cierre ${grande.cierre ?? 'ninguno'}`)

  // REST: límite por usuario en el gateway.
  await esperar(1500)
  const rafaga = await Promise.all([...Array(40)].map(() => llamar('GET', '/api/orbes/saldo', { token: abusadores[5].token })
    .catch(() => ({ estado: 0, cabeceras: new Headers() }))))
  const con429 = rafaga.filter((r) => r.estado === 429)
  const sinRespuesta = rafaga.filter((r) => r.estado === 0).length
  comprobar('40 peticiones REST simultáneas → el excedente recibe 429 con Retry-After',
    con429.length > 0 && con429.every((r) => r.cabeceras.get('retry-after') === '1'),
    `${rafaga.filter((r) => r.estado === 200).length} atendidas, ${con429.length} con 429${sinRespuesta ? `, ${sinRespuesta} sin respuesta (red)` : ''}`)
  comprobar('Otro usuario no se ve afectado por la ráfaga REST', (await llamar('GET', '/api/orbes/saldo', { token: cata.token })).estado === 200)

  const salud = await Promise.all(['api-gateway', 'realtime-gateway', 'auction-service'].map(async (s) => {
    const r = await fetch(`${urlDe(s)}/actuator/health`).catch(() => null)
    return `${s} ${r?.status ?? 'sin respuesta'}`
  }))
  comprobar('0 caídas: gateway, realtime y auction siguen UP', salud.every((s) => s.endsWith('200')), salud.join(' · '))
}

// ── Métricas (con INTERNAL_TOKEN) ────────────────────────────────────────────────────────────────────
async function medidasDeMetricas(gente) {
  console.log('\nMétricas (/actuator/prometheus de cada servicio)')
  if (!INTERNAL_TOKEN) {
    console.log('– Sin INTERNAL_TOKEN: el p95 de login (< 3 s) y el de la verificación (< 5 ms) se miran en Grafana.')
    return
  }
  const identity = await metricas('identity-service')
  const esLogin = (l) => l.includes('uri="/api/sesion/google"') && l.includes('status="201"')
  const login = fraccionBajo(identity, 'http_server_requests_seconds', esLogin, 3)
  if (login.total > 0) {
    comprobar('SEG-01 · El inicio de sesión legítimo tarda menos de 3 s en p95', login.dentro / login.total >= 0.95,
      `${login.dentro}/${login.total} logins con Google bajo 3 s`)
  } else {
    // Sin buckets en esta versión de identity: se usa el máximo. Si el login más lento tardó menos de 3 s, el p95
    // también (la condición es más estricta que la del escenario).
    const valor = (sufijo) => identity.split('\n').filter((l) => l.startsWith(`http_server_requests_seconds_${sufijo}{`) && esLogin(l))
      .reduce((s, l) => (sufijo === 'max' ? Math.max(s, Number(l.slice(l.lastIndexOf(' ') + 1))) : s + Number(l.slice(l.lastIndexOf(' ') + 1))), 0)
    const cantidad = valor('count'), maximo = valor('max')
    // El máximo de Micrometer vuelve a 0 tras unos minutos sin logins: 0 no es una medida, hay que repetir.
    comprobar('SEG-01 · El inicio de sesión legítimo tarda menos de 3 s en p95', cantidad > 0 && maximo > 0 && maximo < 3,
      !cantidad ? 'esta réplica aún no registra logins con Google: entra con Google y repite'
        : maximo === 0 ? `${cantidad} logins con Google, pero ninguno en los últimos minutos: entra con Google y repite enseguida`
          : `${cantidad} logins con Google; el más lento de los últimos minutos tardó ${(maximo * 1000).toFixed(0)} ms`)
  }

  // SEG-02 pide la medida en "operación normal". El histograma del gateway acumula desde que arrancó la réplica,
  // con el arranque en frío y las ráfagas de SEG-03 (40 peticiones simultáneas, 25 atacantes a la vez), que en una
  // réplica de 0,5 vCPU pausan el hilo en medio de la medición. Por eso se mide la diferencia entre dos fotos
  // alrededor de 200 peticiones autenticadas a ritmo normal: 4 usuarios, de a una petición cada uno.
  const esSesion = (l) => l.includes('etapa="sesion"')
  // Con varias réplicas cada lectura de /actuator/prometheus cae en una al azar: se leen varias veces y se agrupan
  // por la etiqueta `instancia` (única por réplica), y la diferencia se calcula réplica por réplica.
  async function fotosPorReplica(lecturas = 12) {
    const fotos = new Map()
    for (let i = 0; i < lecturas; i++) {
      const texto = await metricas('api-gateway')
      const instancia = texto.match(/instancia="([^"]+)"/)?.[1] ?? 'unica'
      const uptime = Number(texto.split('\n').find((l) => l.startsWith('process_uptime_seconds'))?.split(' ').at(-1) ?? NaN)
      fotos.set(instancia, { ...fraccionBajo(texto, 'cafeorbe_seguridad_verificacion_seconds', esSesion, 0.005), uptime })
    }
    return fotos
  }
  const antes = await fotosPorReplica()
  const usuarios = [gente.cata, gente.luis, gente.otroSubastador, gente.abusadores[1]]
  await Promise.all(usuarios.map(async (u) => {
    for (let i = 0; i < 50; i++) {
      await llamar('GET', u.rol === 'SUBASTADOR' ? '/api/subastas/mias' : '/api/orbes/saldo', { token: u.token })
      await esperar(100)
    }
  }))
  const despues = await fotosPorReplica()
  const normal = { dentro: 0, total: 0 }
  const acumulado = { dentro: 0, total: 0 }
  for (const [instancia, d] of despues) {
    acumulado.dentro += d.dentro; acumulado.total += d.total
    const a = antes.get(instancia)
    if (a) { normal.dentro += d.dentro - a.dentro; normal.total += d.total - a.total }
  }
  const pct = (f) => (f.total ? ((100 * f.dentro) / f.total).toFixed(1) : '0')
  const sinPar = [...despues.keys()].filter((i) => !antes.has(i)).length
  comprobar('SEG-02 · Verificación de la sesión en el gateway < 5 ms en p95 (operación normal)',
    normal.total >= 150 && normal.dentro / normal.total >= 0.95,
    `${normal.dentro}/${normal.total} bajo 5 ms (${pct(normal)} %) en 200 peticiones a ritmo normal, ${despues.size} réplica(s)`
    + (normal.total < 150 ? ` · pocas muestras emparejadas${sinPar ? ` (${sinPar} réplica(s) solo leídas al final)` : ''}: repite` : ''))
  const minutos = [...despues.values()].map((d) => (Number.isNaN(d.uptime) ? '?' : `${Math.round(d.uptime / 60)} min`)).join(', ')
  console.log(`  (informativo) acumulado de las réplicas (encendidas hace ${minutos}), con arranque y ráfagas de SEG-03: `
    + `${acumulado.dentro}/${acumulado.total} (${pct(acumulado)} %)`)
  for (const servicio of ['identity-service', 'auction-service', 'wallet-service', 'streaming-service']) {
    const v = fraccionBajo(await metricas(servicio), 'cafeorbe_seguridad_verificacion_seconds', (l) => l.includes('etapa="credencial_interna"'), 0.005)
    comprobar(`SEG-02 · Credencial interna en ${servicio} < 5 ms en p95`, v.total === 0 || v.dentro / v.total >= 0.95,
      v.total ? `${v.dentro}/${v.total} bajo 5 ms (${((100 * v.dentro) / v.total).toFixed(1)} %)` : 'sin peticiones todavía')
  }
}

async function main() {
  console.log(`Seguridad en ${API} · ${WS}\n`)
  await seg01()

  const gente = {
    luis: await sesion('Seg Luis', 'SUBASTADOR'),
    otroSubastador: await sesion('Seg Otro', 'SUBASTADOR'),
    cata: await sesion('Seg Cata', 'COMPRADOR'),
    abusadores: await Promise.all([...Array(6).keys()].map((i) => sesion(`Seg Abusador ${i}`, 'COMPRADOR'))),
    atacantes: await Promise.all([...Array(25).keys()].map((i) => sesion(`Seg Atacante ${i}`, 'COMPRADOR'))),
  }
  const subasta = (await exigirOk('POST', '/api/subastas', {
    token: gente.luis.token,
    cuerpo: { nombre: `Seguridad ${sufijo}`, descripcion: 'Prueba de SEG-01 a SEG-03', fechaInicio: new Date(Date.now() + 30 * 60_000).toISOString() },
  })).id
  const reglas = { duracionMinutos: DURACION_MINUTOS, precioBase: 100, incrementoMinimo: 10 }
  await exigirOk('PUT', `/api/subastas/${subasta}/reglas`, { token: gente.luis.token, cuerpo: reglas })

  await seg02(gente, subasta, reglas)

  await exigirOk('POST', `/api/subastas/${subasta}/iniciar`, { token: gente.luis.token })
  await esperar(1000)
  const salaLuis = await abrirSala(subasta, gente.luis)
  salaLuis.enviar({ tipo: 'PUJAR', monto: 110 })
  await esperar(1500)
  const errorLuis = salaLuis.mensajes.find((m) => m.tipo === 'ERROR')
  comprobar('Subastador manda PUJAR por WebSocket → ERROR "No autorizado"', errorLuis?.datos?.mensaje === 'No autorizado')
  salaLuis.ws.close()

  await seg03(gente, subasta)
  await medidasDeMetricas(gente)

  console.log(`\n${fallas === 0 ? 'SEG-01, SEG-02 y SEG-03 cumplen en este ambiente' : `${fallas} comprobación(es) fallida(s)`}`)
  console.log(`Subasta de prueba ${subasta}: cierra sola en ${DURACION_MINUTOS} min.`)
  console.log('Registro de los intentos (Log Analytics): ContainerAppConsoleLogs_CL | extend j = parse_json(Log_s)'
    + ' | where tostring(j.logger_name) == "cafeorbe.seguridad" | summarize count() by tostring(j.evento), tostring(j.motivo)')
  process.exit(fallas === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
