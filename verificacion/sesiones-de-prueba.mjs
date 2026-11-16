// Sesiones para las pruebas automáticas (e2e, UI y carga).
//
// CaféOrbe no tiene login propio (SEG-01): solo se entra con una cuenta de Google. Un script no puede usar
// cientos de cuentas de Google, así que esta herramienta del OPERADOR hace lo mismo que identity tras verificar
// a Google, sin pasar por ningún endpoint de acceso:
//
//   1. Firma el token de sesión (JWT HS256 con jti) con JWT_SECRET, igual que TokenService de identity.
//   2. Publica UsuarioRegistrado en el broker, igual que identity, para que wallet cargue los Orbes iniciales.
//
// No es una puerta trasera de la aplicación: exige el secreto del servidor (JWT_SECRET) y las credenciales del
// broker, que solo tiene quien opera el ambiente, y no existe dentro de ningún servicio desplegado. Los tokens
// tienen la misma forma y vida que los reales, así que el api-gateway, identity (tickets WebSocket y cierre de
// sesión) y el realtime-gateway los tratan igual.
//
// Variables (los valores por defecto sirven con el entorno local de cafeorbe-infra):
//   JWT_SECRET         Secreto de identity y api-gateway.
//   BROKER_API_URL     API HTTP de administración del broker. Local: http://localhost:15672.
//                      CloudAMQP (LavinMQ): https://<host>.lmq.cloudamqp.com
//   BROKER_USER, BROKER_PASSWORD, BROKER_VHOST   Credenciales y vhost del broker (en CloudAMQP, el vhost es el usuario).

import { createHash, createHmac, randomUUID } from 'node:crypto'

const SECRETO = process.env.JWT_SECRET ?? 'cafeorbe-dev-jwt-secret-cambiar-en-prod-0123456789'
const HORAS_DE_VIDA = Number(process.env.JWT_HORAS ?? 8)
const BROKER_API = (process.env.BROKER_API_URL ?? 'http://localhost:15672').replace(/\/$/, '')
const BROKER_USER = process.env.BROKER_USER ?? 'cafeorbe'
const BROKER_PASSWORD = process.env.BROKER_PASSWORD ?? 'cafeorbe'
const BROKER_VHOST = process.env.BROKER_VHOST ?? '/'

const EXCHANGE = 'cafeorbe.eventos'
const USUARIO_REGISTRADO = 'usuario.registrado'

const base64url = (datos) => Buffer.from(datos).toString('base64url')

/** UUID estable a partir de un texto: el mismo nombre y rol son siempre la misma persona de prueba. */
export function uuidDe(texto) {
  const h = createHash('sha256').update(texto).digest('hex')
  const variante = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variante}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Mismo token que emite identity: sub, nombre, rol, jti, iat y exp, firmado con HS256. */
export function firmarSesion({ id, nombre, rol }, { horas = HORAS_DE_VIDA } = {}) {
  const ahora = Math.floor(Date.now() / 1000)
  const cabecera = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const cuerpo = base64url(JSON.stringify({ jti: randomUUID(), sub: id, nombre, rol, iat: ahora, exp: ahora + horas * 3600 }))
  const firma = createHmac('sha256', SECRETO).update(`${cabecera}.${cuerpo}`).digest('base64url')
  return `${cabecera}.${cuerpo}.${firma}`
}

/** Publica UsuarioRegistrado como lo haría identity. wallet es idempotente por eventId: repetirlo no duplica Orbes. */
async function registrar({ id, nombre, rol }) {
  const evento = { eventId: uuidDe(`registro:${id}`), tipo: USUARIO_REGISTRADO, version: 1, ocurridoEn: new Date().toISOString(),
    datos: { usuarioId: id, nombre, rol } }
  const r = await fetch(`${BROKER_API}/api/exchanges/${encodeURIComponent(BROKER_VHOST)}/${EXCHANGE}/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${BROKER_USER}:${BROKER_PASSWORD}`).toString('base64'),
    },
    body: JSON.stringify({
      routing_key: USUARIO_REGISTRADO,
      payload: JSON.stringify(evento),
      payload_encoding: 'string',
      properties: {
        content_type: 'application/json',
        message_id: evento.eventId,
        headers: { __TypeId__: 'com.cafeorbe.contracts.EventoEnvelope' },
      },
    }),
  })
  if (!r.ok) throw new Error(`No se pudo publicar UsuarioRegistrado en ${BROKER_API} (HTTP ${r.status}): revisa BROKER_*`)
  const { routed } = await r.json()
  if (!routed) throw new Error('El broker aceptó UsuarioRegistrado pero ninguna cola lo recibió: ¿está arriba wallet?')
}

const registrados = new Set()

/**
 * Sesión de una persona de prueba. Devuelve lo mismo que devolvía el acceso por nombre del Sprint 1:
 * { token, usuario: { id, nombre, rol }, nuevo }. La primera vez de cada persona se registra en wallet.
 */
export async function sesionDePrueba(nombre, rol) {
  const usuario = { id: uuidDe(`prueba:${nombre.trim().toLowerCase()}:${rol}`), nombre: nombre.trim(), rol }
  const nuevo = !registrados.has(usuario.id)
  // SIN_REGISTRO=1: solo firma la sesión, sin publicar en el broker. Sirve para pruebas que no necesitan Orbes
  // (seguridad-qa.mjs); la persona queda con saldo 0 y sus pujas se rechazan por saldo, no por permisos.
  if (nuevo && process.env.SIN_REGISTRO !== '1') {
    await registrar(usuario)
    registrados.add(usuario.id)
  }
  return { token: firmarSesion(usuario), usuario, nuevo }
}
