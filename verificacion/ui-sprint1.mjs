// Verificación de la interfaz del Sprint 1 en Chrome sin interfaz (headless), controlado por CDP.
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sesionDePrueba } from './sesiones-de-prueba.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const WEB = 'http://localhost:5173'
const API = 'http://localhost:8080'
const PUERTO = 9333
const SALDO = process.env.SALDO_INICIAL ?? '100000000'
const orbes = (n) => `${Number(n).toLocaleString('es-CO')} Orbes` // la pantalla separa los miles: "100.000.000 Orbes"
const sufijo = Date.now().toString(36)
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

const resultados = []
function comprobar(hu, nombre, ok, detalle = '') {
  resultados.push({ hu, nombre, ok })
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${hu} · ${nombre}${ok ? '' : `  → ${detalle}`}`)
}

async function http(metodo, ruta, token, cuerpo) {
  const headers = {}
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(API + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) })
  const t = await r.text()
  return t ? JSON.parse(t) : null
}

// ── Chrome + CDP ─────────────────────────────────────────────────────────
const perfil = mkdtempSync(join(tmpdir(), 'cafeorbe-ui-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PUERTO}`, `--user-data-dir=${perfil}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })

let ws
let siguienteId = 1
const pendientes = new Map()
const erroresDeConsola = []

async function conectar() {
  let objetivos = null
  for (let i = 0; i < 50 && !objetivos; i++) {
    objetivos = await fetch(`http://localhost:${PUERTO}/json/list`).then((r) => r.json()).catch(() => null)
    if (!objetivos) await esperar(200)
  }
  const pagina = objetivos.find((o) => o.type === 'page')
  ws = new WebSocket(pagina.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pendientes.has(m.id)) {
      pendientes.get(m.id)(m)
      pendientes.delete(m.id)
    } else if (m.method === 'Runtime.exceptionThrown') {
      erroresDeConsola.push('EXCEPCIÓN: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text))
    } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      erroresDeConsola.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      erroresDeConsola.push(`red: ${m.params.entry.text} ${m.params.entry.url ?? ''}`.slice(0, 300))
    }
  }
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Log.enable')
}

function cdp(method, params = {}) {
  const id = siguienteId++
  return new Promise((resolver, rechazar) => {
    pendientes.set(id, (m) => (m.error ? rechazar(new Error(m.error.message)) : resolver(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function js(expresion) {
  const r = await cdp('Runtime.evaluate', { expression: expresion, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

async function ir(ruta) {
  await cdp('Page.navigate', { url: WEB + ruta })
  await esperar(600)
}

/** Espera a que la expresión sea verdadera; devuelve su valor o null si se agota el tiempo. */
async function hasta(expresion, ms = 8000) {
  const fin = Date.now() + ms
  for (;;) {
    const v = await js(expresion).catch(() => null)
    if (v) return v
    if (Date.now() > fin) return null
    await esperar(200)
  }
}

const texto = () => js('document.body.innerText')
const ruta = () => js('location.pathname')
const clic = (selector) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true })()`)
const clicBoton = (rotulo) =>
  js(`(() => { const b = [...document.querySelectorAll('button, a')].find((e) => e.innerText.trim().includes(${JSON.stringify(rotulo)})); if (!b) return false; b.click(); return true })()`)
const boton = (rotulo) =>
  js(`(() => { const b = [...document.querySelectorAll('button')].find((e) => e.innerText.trim().includes(${JSON.stringify(rotulo)})); return b ? { texto: b.innerText.trim(), deshabilitado: b.disabled } : null })()`)
const botonPuja = () => js(`(() => { const b = document.querySelector('.boton--puja'); return b ? { texto: b.innerText.replace(/\\s+/g, ' ').trim(), deshabilitado: b.disabled } : null })()`)

async function escribir(selector, valor) {
  await js(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  await cdp('Input.insertText', { text: valor })
}

/**
 * SEG-01: la aplicación solo deja entrar con Google, que un navegador automatizado no puede usar. La sesión la
 * firma sesiones-de-prueba.mjs y se guarda donde la deja el ingreso con Google.
 */
async function entrarComo(sesion) {
  await ir('/login')
  await js(`sessionStorage.setItem('cafeorbe.sesion', ${JSON.stringify(JSON.stringify({ token: sesion.token, usuario: sesion.usuario }))})`)
}

async function sesionApi(nombre, rol) {
  // SEG-01: no hay login propio; la sesión la firma la herramienta del operador (sesiones-de-prueba.mjs).
  const r = await sesionDePrueba(nombre, rol)
  return { token: r.token, usuario: r.usuario }
}

async function main() {
  await conectar()

  // Datos de apoyo por API: un Subastador con una subasta En curso (base 100, incremento 10).
  const luis = await sesionApi(`Luis UI ${sufijo}`, 'SUBASTADOR')
  const subasta = (await http('POST', '/api/subastas', luis.token, { nombre: `Lote UI ${sufijo}`, descripcion: 'Bourbon rosado', fechaInicio: new Date(Date.now() + 1800_000).toISOString() })).id
  await http('PUT', `/api/subastas/${subasta}/ficha`, luis.token, { identificacion: 'UI-001', tipoCafe: 'Bourbon', pesoKg: 35, edadMeses: 2, observaciones: '' })
  await http('PUT', `/api/subastas/${subasta}/reglas`, luis.token, { duracionMinutos: 10, precioBase: 100, incrementoMinimo: 10 })

  // ── HU-01 / SEG-01 · Pantalla de acceso ──────────────────────────────
  // Solo Google: no hay campo de nombre ni contraseña, y el botón de Google aparece tras elegir el rol.
  await ir('/login')
  await hasta(`document.body.innerText.includes('Entra a la subasta')`)
  const sinLoginPropio = await js(`!document.querySelector('input[type="text"], input[type="password"]') && !document.body.innerText.includes('Entrar a la sala')`)
  comprobar('SEG-01', 'el acceso no tiene login propio (ni nombre ni contraseña)', sinLoginPropio === true, (await texto()).slice(0, 200))
  const pideRol = await js(`document.body.innerText.includes('Selecciona un rol para continuar.')`)
  comprobar('HU-01', 'sin rol pide elegirlo antes de entrar con Google', pideRol === true)

  // La persona de prueba entra con la sesión firmada (el botón de Google no se puede automatizar).
  const ana = await sesionApi(`Ana UI ${sufijo}`, 'COMPRADOR')
  await entrarComo(ana)
  await ir('/comprador')
  const enHome = await hasta(`location.pathname === '/comprador'`)
  comprobar('HU-01', 'con sesión de Comprador se abre el home del Comprador', !!enHome, await ruta())

  // ── HU-04, HU-06, HU-07 · Home del Comprador ─────────────────────────
  // El aviso de bienvenida sale tras un ingreso real con Google (lo cubre App.test.tsx); aquí se comprueba
  // que la carga automática llegó al saldo.
  const saldoBarra = await hasta(`document.querySelector('.saldo')?.innerText.includes('${orbes(SALDO)}')`)
  comprobar('HU-06', `la barra superior muestra "${orbes(SALDO)}" en el home`, !!saldoBarra, await js(`document.querySelector('.saldo')?.innerText`))
  const tarjeta = await hasta(`[...document.querySelectorAll('.lote')].some((l) => l.innerText.includes('Lote UI ${sufijo}') && l.innerText.includes('Entrar'))`)
  comprobar('HU-04', 'el listado muestra la subasta con nombre, estado y botón Entrar', !!tarjeta)

  // ── HU-03 · Acceso denegado a otro rol ───────────────────────────────
  await ir('/subastador')
  const devuelto = await hasta(`location.pathname === '/comprador' && document.body.innerText.includes('No autorizado')`, 4000)
  comprobar('HU-03', 'un Comprador en la ruta del Subastador vuelve a su home con "No autorizado"', !!devuelto, `${await ruta()}`)

  // ── HU-05 · Sala de una subasta inexistente (corrección de esta sesión) ──
  await ir('/subastas/00000000-0000-4000-8000-000000000000/sala')
  const errorSala = await hasta(`document.body.innerText.includes('No pudimos abrir la sala')`, 6000)
  comprobar('HU-05', 'una subasta inexistente muestra el error en vez de quedarse cargando', !!errorSala && (await texto()).includes('La subasta no existe'), (await texto()).slice(0, 200))

  // ── HU-05, HU-09 · Sala Programada ───────────────────────────────────
  await ir(`/subastas/${subasta}/sala`)
  const salaLista = await hasta(`document.body.innerText.includes('Lote UI ${sufijo}') && !!document.querySelector('.boton--puja')`)
  const t = await texto()
  comprobar('HU-05', 'la sala carga el lote, el precio y el estado', !!salaLista && t.includes('Programada') && t.includes('100'), t.slice(0, 300))
  comprobar('HU-09', 'la ficha técnica se ve en la sala en modo lectura', t.includes('UI-001') && t.includes('Bourbon') && t.includes('35 kg'))
  comprobar('HU-06', 'la barra superior muestra el saldo también en la sala', !!(await hasta(`document.querySelector('.saldo')?.innerText.includes('${orbes(SALDO)}')`)))
  const antes = await botonPuja()
  comprobar('HU-12', 'antes de iniciar el botón de puja está deshabilitado', antes?.deshabilitado === true && antes.texto.includes('La subasta aún no inicia'), JSON.stringify(antes))
  comprobar('HU-11', 'sin transmisión se ve "La transmisión aún no ha iniciado"', t.includes('La transmisión aún no ha iniciado'))
  const conectados = await hasta(`document.querySelector('.conectados')?.innerText.includes('1')`)
  comprobar('HU-05', 'la sala registra la conexión (1 conectados)', !!conectados, await js(`document.querySelector('.conectados')?.innerText`))

  // ── HU-12, HU-13 · Inicio en vivo y puja rápida ──────────────────────
  await http('POST', `/api/subastas/${subasta}/iniciar`, luis.token)
  const habilitado = await hasta(`(() => { const b = document.querySelector('.boton--puja'); return b && !b.disabled && b.innerText.replace(/\\s+/g, ' ').includes('Pujar 110') })()`, 5000)
  comprobar('HU-12', 'al iniciar, la sala pasa a En curso y habilita "Pujar 110" sin recargar', !!habilitado && (await texto()).includes('En curso'), JSON.stringify(await botonPuja()))
  comprobar('HU-13', 'sin pujas se ve la leyenda "Sin pujas"', (await texto()).includes('Sin pujas'))
  await clic('.boton--puja')
  const lider = await hasta(`(() => { const b = document.querySelector('.boton--puja'); return b && b.disabled && b.innerText.includes('Vas ganando') })()`, 5000)
  const t2 = await texto()
  comprobar('HU-13', 'puja rápida: precio 110, quedo líder y el botón dice "Vas ganando" deshabilitado', !!lider && (await js(`document.querySelector('.precio__valor')?.innerText`)) === '110', JSON.stringify(await botonPuja()))
  comprobar('HU-14', 'la puja aparece en "Últimas pujas" con usuario, monto y hora', t2.includes(`Ana UI ${sufijo}`) && t2.includes('1 pujas'))

  // Otro comprador puja por API: la pantalla de Ana se actualiza sola.
  const bea = await sesionApi(`Bea UI ${sufijo}`, 'COMPRADOR')
  await esperar(1500)
  await http('POST', `/api/subastas/${subasta}/pujas`, bea.token, { monto: 120 })
  const superada = await hasta(`(() => { const b = document.querySelector('.boton--puja'); return b && !b.disabled && b.innerText.replace(/\\s+/g, ' ').includes('Pujar 130') })()`, 5000)
  comprobar('HU-13', 'al ser superada, el botón propone el nuevo mínimo (Pujar 130) sin recargar', !!superada && (await texto()).includes(`Lidera Bea UI ${sufijo}`), JSON.stringify(await botonPuja()))

  // ── HU-13 · Sin saldo (corrección de esta sesión) ────────────────────
  const cero = await sesionApi(`Cero UI ${sufijo}`, 'COMPRADOR')
  await esperar(1500)
  execSync(`docker exec cafeorbe-postgres-1 psql -U postgres -d wallet_db -c "update cuenta set saldo = 0 where usuario_id = '${cero.usuario.id}'"`, { stdio: 'ignore' })
  await entrarComo(cero)
  await ir(`/subastas/${subasta}/sala`)
  const sinSaldo = await hasta(`(() => { const b = document.querySelector('.boton--puja'); return b && b.disabled && b.innerText.includes('Orbes insuficientes') })()`, 8000)
  comprobar('HU-13', 'con 0 Orbes el botón se deshabilita con "Orbes insuficientes"', !!sinSaldo && (await js(`document.querySelector('.saldo')?.innerText`)).includes('0 Orbes'), JSON.stringify(await botonPuja()))

  // ── HU-05 · Sala con el realtime-gateway caído (corrección de esta sesión) ──
  execSync('docker stop cafeorbe-realtime-gateway-1', { stdio: 'ignore' })
  await entrarComo(bea)
  await ir(`/subastas/${subasta}/sala`)
  const sinTiempoReal = await hasta(`document.body.innerText.includes('Lote UI ${sufijo}') && !!document.querySelector('.boton--puja')`, 8000)
  const t3 = await texto()
  comprobar('HU-05', 'sin realtime-gateway la sala igual muestra el lote y el precio, con el aviso de conexión', !!sinTiempoReal && t3.includes('120') && (t3.includes('Reconectando') || t3.includes('Conectando')), t3.slice(0, 300))
  execSync('docker start cafeorbe-realtime-gateway-1', { stdio: 'ignore' })
  const reconectada = await hasta(`!document.querySelector('.conexion') && document.querySelector('.conectados')?.innerText.includes('1')`, 60000)
  comprobar('HU-05', 'al volver el realtime-gateway la sala se reconecta sola', !!reconectada, JSON.stringify({ conexion: await js(`document.querySelector('.conexion')?.innerText ?? null`), conectados: await js(`document.querySelector('.conectados')?.innerText ?? null`) }))

  // ── HU-02 · Cerrar sesión ────────────────────────────────────────────
  await ir('/comprador')
  await hasta(`!!document.querySelector('button[aria-label="Cerrar sesión"]')`)
  await clic('button[aria-label="Cerrar sesión"]')
  const fuera = await hasta(`location.pathname === '/login'`, 3000)
  comprobar('HU-02', 'Cerrar sesión borra los datos y lleva a la pantalla de acceso', !!fuera && (await js(`sessionStorage.getItem('cafeorbe.sesion')`)) === null)
  await js(`window.addEventListener('pageshow', (e) => { window.__persistida = e.persisted })`)
  await js('history.back()')
  const sigueFuera = await hasta(`location.pathname === '/login'`, 5000)
  comprobar('HU-02', 'con el botón Atrás se sigue en la pantalla de acceso', !!sigueFuera, JSON.stringify({ ruta: await ruta(), sesionGuardada: await js(`sessionStorage.getItem('cafeorbe.sesion') !== null`), barra: await js(`document.querySelector('.barra__nombre')?.innerText ?? null`), tipoNavegacion: await js(`performance.getEntriesByType('navigation')[0]?.type`) }))

  // ── HU-03, HU-08 · Subastador ────────────────────────────────────────
  await entrarComo(luis)
  await ir('/subastador')
  const homeSub = await hasta(`document.body.innerText.includes('Crear subasta') && document.body.innerText.includes('Mis subastas')`)
  const t4 = await texto()
  comprobar('HU-03', 'home del Subastador: nombre, etiqueta Subastador, Crear subasta, Mis subastas y Cerrar sesión', !!homeSub && t4.includes(`Luis UI ${sufijo}`) && t4.includes('Subastador') && !!(await js(`!!document.querySelector('button[aria-label="Cerrar sesión"]')`)), t4.slice(0, 200))
  // HU-24: el Subastador también ve su saldo, que crece con cada venta. Se lee un booleano: un nodo del DOM no
  // se puede devolver por CDP.
  const saldoSubastador = await hasta(`!!document.querySelector('.saldo')`)
  comprobar('HU-24', 'el Subastador ve su saldo de Orbes en la barra superior', !!saldoSubastador, await js(`document.querySelector('.saldo')?.innerText ?? 'sin saldo'`))
  await ir('/subastador/subastas/nueva')
  await hasta(`!!document.querySelector('form')`)
  await clicBoton('Guardar')
  const faltantes = await hasta(`document.body.innerText.includes('El nombre es obligatorio') && document.body.innerText.includes('La fecha de inicio es obligatoria')`, 3000)
  comprobar('HU-08', 'el formulario señala los campos faltantes junto a cada campo', !!faltantes && (await ruta()) === '/subastador/subastas/nueva')
  await ir('/subastador/subastas')
  const mias = await hasta(`document.body.innerText.includes('Lote UI ${sufijo}')`)
  comprobar('HU-03', 'Mis subastas lista las subastas propias', !!mias)

  // ── HU-12 · Botón Iniciar sin configuración ──────────────────────────
  const sinReglas = (await http('POST', '/api/subastas', luis.token, { nombre: `Sin reglas ${sufijo}`, descripcion: '', fechaInicio: new Date(Date.now() + 1800_000).toISOString() })).id
  await ir(`/subastador/subastas/${sinReglas}`)
  await hasta(`document.body.innerText.includes('Sin reglas ${sufijo}')`)
  const iniciar = await boton('Iniciar subasta')
  comprobar('HU-12', 'Iniciar subasta deshabilitado con el motivo cuando falta configuración', iniciar?.deshabilitado === true && (await texto()).includes('Configura primero el tiempo y las reglas de puja'), JSON.stringify(iniciar))

  // ── HU-09 · Edición bloqueada tras iniciar ───────────────────────────
  await ir(`/subastador/subastas/${subasta}`)
  const bloqueada = await hasta(`document.body.innerText.includes('La ficha no se puede editar con la subasta iniciada')`, 5000)
  comprobar('HU-09', 'con la subasta En curso la ficha queda bloqueada con su mensaje', !!bloqueada && (await js(`document.querySelector('fieldset')?.disabled`)) === true)

  // ── Consola ──────────────────────────────────────────────────────────
  const esperados = erroresDeConsola.filter((e) => /WebSocket|ws:\/\/|404|409|ERR_CONNECTION|Failed to load resource/.test(e))
  const inesperados = erroresDeConsola.filter((e) => !esperados.includes(e))
  comprobar('DoD', `sin errores inesperados en consola (${esperados.length} de red esperados por las pruebas negativas)`, inesperados.length === 0, inesperados.slice(0, 5).join(' | '))

  const fallas = resultados.filter((r) => !r.ok)
  console.log(`\nTOTAL UI: ${resultados.length - fallas.length}/${resultados.length}`)
  return fallas.length ? 1 : 0
}

let codigo = 2
try {
  codigo = await main()
} catch (e) {
  console.error('ERROR INESPERADO', e)
  try { execSync('docker start cafeorbe-realtime-gateway-1', { stdio: 'ignore' }) } catch { /* ya estaba arriba */ }
} finally {
  try { await cdp('Browser.close') } catch { /* ya cerrado */ }
  chrome.kill()
}
process.exit(codigo)
