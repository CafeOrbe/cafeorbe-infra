import { readFileSync } from 'node:fs';
const api = 'https://api-gateway.blackbay-48700ead.eastus2.azurecontainerapps.io';
const id = '79ff79c1-195f-4864-8f32-165e701ba84c';
const result = { observadoEn: new Date().toISOString(), node: process.version, websocketDisponible: typeof WebSocket === 'function' };
try {
  const users = JSON.parse(readFileSync(new URL('../compradores.json', import.meta.url), 'utf8')).slice(0, 200);
  const claims = users.map(u => JSON.parse(Buffer.from(u.token.split('.')[1], 'base64url')));
  result.compradores = { cantidad: users.length, idsUnicos: new Set(users.map(u=>u.id)).size,
    expiracionMasTemprana: new Date(Math.min(...claims.map(c=>c.exp))*1000).toISOString(),
    vigentesDurante15Min: users.length === 200 && claims.every(c=>Number.isFinite(c.exp) && c.exp*1000 > Date.now()+900000) };
  const response = await fetch(`${api}/api/subastas/${id}`, { headers: { Authorization: `Bearer ${users[0].token}` }, signal: AbortSignal.timeout(15000) });
  result.httpStatus = response.status;
  if(response.ok) {
    const state = await response.json();
    result.subasta = {id, estado:state.estado, horaFin:state.horaFin, precioActual:state.precioActual, siguienteMinimo:state.siguienteMinimo, cantidadPujas:state.cantidadPujas, reglas:state.reglas};
  }
} catch (e) { result.error = e.cause?.code || e.code || e.message; }
console.log(JSON.stringify(result));
if(result.error || result.httpStatus !== 200 || result.subasta?.estado !== 'EN_CURSO' || !result.websocketDisponible || !result.compradores?.vigentesDurante15Min || result.compradores?.idsUnicos !== 200) process.exitCode=1;
