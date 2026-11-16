"""DIS-01: tras el cierre de la subasta, exactamente un cierre (auction) y un cobro (wallet). Solo lectura.
   PGHOST/PGUSER/PGPASSWORD de auction y WPGUSER/WPGPASSWORD de wallet por entorno; nunca se imprimen.
   python3 verificar-cierre.py <subastaId>"""
import os, sys, ssl, json
if os.environ.get('REN_PY_DEPS'):
    sys.path.insert(0, os.environ['REN_PY_DEPS'])
import pg8000.native as pg

sid = sys.argv[1]


def con(db, usuario, clave):
    return pg.Connection(usuario, password=clave, host=os.environ['PGHOST'], database=db,
                         ssl_context=ssl.create_default_context(), timeout=20)


a = con('auction_db', os.environ['PGUSER'], os.environ['PGPASSWORD'])
try:
    a.run('BEGIN READ ONLY')
    estado = a.run('select estado, lider_id::text from subasta where id = cast(:i as uuid)', i=sid)
    cierres = a.run("select count(*) from outbox where tipo = 'subasta.cerrada' and payload like :p", p=f'%{sid}%')[0][0]
    a.run('COMMIT')
finally:
    a.close()

w = con('wallet_db', os.environ['WPGUSER'], os.environ['WPGPASSWORD'])
try:
    w.run('BEGIN READ ONLY')
    movs = w.run('select tipo, count(*) from movimiento where referencia like :p group by tipo', p=f'%{sid}%')
    w.run('COMMIT')
finally:
    w.close()

r = {'subasta': sid, 'estado': estado[0][0] if estado else None, 'conGanador': bool(estado and estado[0][1]),
     'eventosDeCierre': cierres, 'movimientosWallet': {t: n for t, n in movs}}
r['cumple'] = (r['estado'] in ('FINALIZADA', 'DESIERTA') and cierres == 1
               and (not r['conGanador'] or (r['movimientosWallet'].get('COBRO') == 1)))
print(json.dumps(r, ensure_ascii=False))
sys.exit(0 if r['cumple'] else 1)
