import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { analizar } from './analizar-carga.mjs';
import { evaluarCpuReplica } from './analizar-cpu.mjs';
const dir=resolve(process.argv[2] || '.');
const read=name=>JSON.parse(readFileSync(join(dir,name),'utf8').replace(/^\uFEFF/,''));
const lines=name=>readFileSync(join(dir,name),'utf8').split(/\r?\n/).map(l=>l.replace(/^\uFEFF/,'').trim()).filter(Boolean).map(l=>JSON.parse(l));
const m=read('resultado-objetivo.json'), pg=read('postgres-despues.json'), before=read('postgres-antes.json'), pre=read('precheck.json');
const c=analizar(m,pg);
const add=(criterio,cumple,observado)=>c.push({criterio,cumple,observado});
add('PostgreSQL <25 conexiones antes de carga',Number.isInteger(before.conexionesCliente) && before.conexionesCliente<25,before.conexionesCliente);
const start=Date.parse(m.ventana?.inicioIso),end=Date.parse(m.ventana?.finIso);
const replicaRecords=lines('replicas.ndjson');
const pgRecords=lines('postgres-conexiones.ndjson');
add('Observador PostgreSQL sin errores',pgRecords.length>0 && pgRecords.every(r=>!r.error && Number.isInteger(r.conexionesCliente)),pgRecords);
const cpu=[];
for(const app of ['auction-service','realtime-gateway']) {
  const baseline=pre.apps.find(a=>a.nombre===app);
  const expected=baseline?.replicas?.map(r=>r.nombre).sort() || [];
  const snapshots=replicaRecords.filter(r=>r.app===app);
  const within=snapshots.filter(r=>Date.parse(r.observadoEn)>=start-30000 && Date.parse(r.observadoEn)<=end+30000);
  const stable=within.length>0 && within.every(r=>r.error===0 && r.replicas.length===2 && r.replicas.map(x=>x.nombre).sort().join()===expected.join() && r.replicas.every(x=>x.runningState==='Running' && [x.containers].flat().length>0 && [x.containers].flat().every(k=>k?.ready && k.restartCount===0)));
  const stamps=within.map(r=>Date.parse(r.observadoEn)).sort((a,b)=>a-b);
  const covered=stamps.length>0 && stamps[0]<=start+30000 && stamps.at(-1)>=end-30000 && stamps.every((t,i)=>i===0 || t-stamps[i-1]<=60000);
  add(`${app}: dos replicas estables en muestreo`,!covered?null:expected.length===2 && stable,{replicas:expected,muestras:within.length,intervaloMaximoSegundos:60});
  if(!existsSync(join(dir,`cpu-${app}.json`))) { add(`${app}: CPU por replica <80%`,null,'Falta JSON Azure Monitor');continue; }
  const data=read(`cpu-${app}.json`);
  const series=(data.value || []).flatMap(v=>v.timeseries || []);
  const cpus=baseline.revisiones.flatMap(r=>r.containers).filter(r=>r.nombre===app).map(r=>r.cpu);
  if(cpus.length!==1 || !Number.isFinite(cpus[0])) {add(`${app}: CPU por replica <80%`,null,'No se identifica vCPU de la revision');continue;}
  for(const replica of expected) {
    const matching=series.filter(s=>(s.metadatavalues||s.metadataValues||[]).some(v=>/pod|replica/i.test(v.name?.value || '') && v.value===replica));
    // Todos los minutos que se cruzan con la ventana, incluido el último parcial (ver analizar-cpu.mjs).
    const r=evaluarCpuReplica(matching.flatMap(s=>s.data || []),start,end,cpus[0]);
    add(`${app}/${replica}: CPU <80%`,r.cumple,{maximoPorcentaje:r.maximoPorcentaje,muestras:r.puntos.length,minutosEsperados:r.minutosEsperados,minutosFaltantes:r.minutosFaltantes,coberturaCompleta:r.coberturaCompleta,vcpu:cpus[0]});
    cpu.push({app,replica,points:r.puntos});
  }
}
const dictamen=c.some(r=>r.cumple===false)?'NO CUMPLE':c.every(r=>r.cumple===true)?'CUMPLE':'NO CERTIFICADO';
const safe=v=>JSON.stringify(v).replaceAll('|','/');
writeFileSync(join(dir,'aceptacion.json'),JSON.stringify({dictamen,ventana:m.ventana,criterios:c,cpu},null,2)+'\n');
let md=`# REN-01: ${dictamen}\n\nVentana sostenida UTC: ${m.ventana.inicioIso} — ${m.ventana.finIso}.\n\n| Criterio | Dictamen | Observado |\n|---|---|---|\n`;
for(const row of c) md+=`| ${row.criterio} | ${row.cumple===true?'CUMPLE':row.cumple===false?'NO CUMPLE':'NO VERIFICADO'} | ${safe(row.observado)} |\n`;
md+='\n[Graficas de latencia y CPU](graficas.html). [Carga cruda](resultado-objetivo.json). [CPU y criterios](aceptacion.json). PostgreSQL: postgres-antes.json y postgres-despues.json. Replica y conexion BD: archivos NDJSON.\n\nCPU: Maximum de Azure Monitor a PT1M, normalizado por vCPU configuradas. Estado de replicas muestreado, no monitor continuo. Latencia de pujas aceptadas desde envio hasta cada receptor; rechazos se contabilizan, sin mezclarlos en el percentil. La carga proviene de esta maquina y su red forma parte de la medicion punta a punta. Esta certificacion no depende de Grafana.\n';
writeFileSync(join(dir,'INFORME.md'),md);
const chart=(title,points,limit,maxY)=>{
  const coords=points.map(([x,y])=>`${60+x*840},${310-Math.min(y,maxY)/maxY*240}`).join(' ');
  return `<h2>${title}</h2><svg viewBox="0 0 960 350" role="img" aria-label="${title}"><path d="M60 60V310H900" stroke="#777" fill="none"/><line x1="60" x2="900" y1="${310-limit/maxY*240}" y2="${310-limit/maxY*240}" stroke="#b22" stroke-dasharray="6 4"/><polyline points="${coords}" stroke="#2563a6" fill="none"/><text x="65" y="45">max escala ${maxY}; linea roja ${limit}</text><text x="60" y="338">Inicio</text><text x="850" y="338">Fin</text></svg>`;
};
let graphs=`<!doctype html><html lang="es"><meta charset="utf-8"><title>REN-01 ${dictamen}</title><style>body{font:16px sans-serif;max-width:1100px;margin:30px auto}svg{width:100%;background:#f7f9fc}h2{font-size:18px}</style><h1>REN-01: ${dictamen}</h1><p>Ventana UTC: ${m.ventana.inicioIso} — ${m.ventana.finIso}</p>`;
const events=m.eventos.aceptadosPorSocket.flat().filter(e=>Number.isFinite(e.latenciaMs)).sort((a,b)=>Date.parse(a.recibidoIso)-Date.parse(b.recibidoIso));
const latPoints=events.filter((_,i)=>i%Math.max(1,Math.ceil(events.length/10000))===0).map(e=>[(Date.parse(e.recibidoIso)-start)/(end-start),e.latenciaMs]);
graphs+=chart('Latencia de recepcion por comprador (ms; puntos reducidos solo para dibujar)',latPoints,800,events.reduce((max,e)=>Math.max(max,e.latenciaMs),1500));
for(const series of cpu) graphs+=chart(`CPU ${series.app} / ${series.replica} (%)`,series.points.map(p=>[(Date.parse(p.timestamp)-start)/(end-start),p.porcentaje]),80,Math.max(100,...series.points.map(p=>p.porcentaje)));
writeFileSync(join(dir,'graficas.html'),graphs+'</html>');
console.log(`REN-01: ${dictamen}. Informe: ${join(dir,'INFORME.md')}`);
console.log(c.filter(r=>r.cumple!==true).map(r=>`${r.criterio}: ${r.cumple===false?'NO CUMPLE':'NO VERIFICADO'}`).join('\n'));
process.exitCode=dictamen==='CUMPLE'?0:1;
