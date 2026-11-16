// Fixture de instrumentacion SIN RED. No usar como evidencia de QA.
let state={estado:'EN_CURSO',precioActual:1000,siguienteMinimo:1100,cantidadPujas:0,reglas:{incrementoMinimo:100}};
let ticket=0,sequence=0;
const users=new Map(),clients=[];
globalThis.fetch=async(url,options={})=>{
  if(String(url).endsWith('/ticket-ws')) {
    const id=JSON.parse(Buffer.from(options.headers.Authorization.split(' ')[1].split('.')[1],'base64url')).sub;
    const name=String(ticket++);users.set(name,id);
    return {ok:true,json:async()=>({ticket:name})};
  }
  return {ok:true,json:async()=>structuredClone(state)};
};
globalThis.WebSocket=class {
  static OPEN=1;
  constructor(url) {
    this.user=users.get(new URL(url).searchParams.get('ticket'));this.readyState=1;clients.push(this);
    queueMicrotask(()=>this.onopen?.());
  }
  send(raw) {
    const m=JSON.parse(raw);if(m.tipo==='PING')return;
    if(m.monto<state.siguienteMinimo) {queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({tipo:'PUJA_RECHAZADA',datos:{montoIntentado:m.monto}})}));return;}
    state.precioActual=m.monto;state.siguienteMinimo=m.monto+100;state.cantidadPujas++;
    const data=JSON.stringify({tipo:'PUJA_ACEPTADA',secuencia:++sequence,datos:{monto:m.monto,usuarioId:this.user,cantidadPujas:state.cantidadPujas,siguienteMinimo:state.siguienteMinimo}});
    for(const client of clients) if(client.readyState===1) queueMicrotask(()=>client.onmessage?.({data}));
  }
  close() {this.readyState=3;this.onclose?.({code:1000});}
};
