"""Genera el diagrama UML de despliegue de CaféOrbe (SVG dentro de un HTML) a partir de lo desplegado en Azure.

Uso: python docs/despliegue/generar_diagrama.py  -> docs/despliegue/diagrama-despliegue.html
Luego se exporta a PNG con Edge en modo headless (ver README.md de esta carpeta).
Datos verificados en Azure el 19 nov 2026 (az containerapp/redis/postgres/network/vm/acr).
"""
from pathlib import Path
from xml.sax.saxutils import escape

W, H = 2400, 1500
out = []
VERDE, CAFE, GRIS, AZUL, MORADO = '#0b4438', '#5a3d2b', '#6b6b6b', '#1f5f99', '#6a3d9a'


def caja(x, y, w, h, titulo, lineas=(), estereotipo='', color=VERDE, fondo='#ffffff', nodo3d=True, tam=17):
    if nodo3d:  # nodo UML: cubo con profundidad
        d = 12
        out.append(f'<polygon points="{x},{y} {x+d},{y-d} {x+w+d},{y-d} {x+w},{y}" fill="{fondo}" stroke="{color}" stroke-width="2"/>')
        out.append(f'<polygon points="{x+w},{y} {x+w+d},{y-d} {x+w+d},{y+h-d} {x+w},{y+h}" fill="{fondo}" stroke="{color}" stroke-width="2"/>')
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fondo}" stroke="{color}" stroke-width="2"/>')
    ty = y + 24
    if estereotipo:
        out.append(f'<text x="{x+w/2}" y="{ty}" text-anchor="middle" font-size="13" fill="{GRIS}">«{escape(estereotipo)}»</text>')
        ty += 21
    out.append(f'<text x="{x+w/2}" y="{ty}" text-anchor="middle" font-size="{tam}" font-weight="700" fill="{color}">{escape(titulo)}</text>')
    ty += 22
    for l in lineas:
        out.append(f'<text x="{x+w/2}" y="{ty}" text-anchor="middle" font-size="13.5" fill="#2b2118">{escape(l)}</text>')
        ty += 18


def grupo(x, y, w, h, titulo, color, fondo):
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fondo}" stroke="{color}" stroke-width="2.2" stroke-dasharray="9 5"/>')
    out.append(f'<text x="{x+14}" y="{y+26}" font-size="16" font-weight="700" fill="{color}">{escape(titulo)}</text>')


def flecha(pts, etiqueta='', color=CAFE, guion=False, lx=None, ly=None, ancla='middle', doble=False):
    d = 'M ' + ' L '.join(f'{a},{b}' for a, b in pts)
    dash = ' stroke-dasharray="7 5"' if guion else ''
    ini = ' marker-start="url(#ini)"' if doble else ''
    out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2"{dash} marker-end="url(#fin)"{ini}/>')
    if etiqueta:
        if lx is None:
            (x1, y1), (x2, y2) = pts[len(pts) // 2 - 1], pts[len(pts) // 2]
            lx, ly = (x1 + x2) / 2, (y1 + y2) / 2 - 7
        lineas = etiqueta.split('\n')
        ancho = max(len(t) for t in lineas) * 7.2 + 10
        alto = 18 * len(lineas) + 4
        bx = lx - ancho / 2 if ancla == 'middle' else (lx - 5 if ancla == 'start' else lx - ancho + 5)
        out.append(f'<rect x="{bx}" y="{ly-15}" width="{ancho}" height="{alto}" fill="#fffaf2" opacity="0.93" rx="3"/>')
        for i, t in enumerate(lineas):
            out.append(f'<text x="{lx}" y="{ly + i*18}" text-anchor="{ancla}" font-size="13" fill="{color}" font-weight="600">{escape(t)}</text>')


# ---------- Título ----------
out.append(f'<text x="40" y="46" font-size="27" font-weight="700" fill="{VERDE}">Diagrama UML de despliegue — CaféOrbe (QA en Azure, verificado el 19 nov 2026)</text>')

# ---------- Columna izquierda: cliente y servicios externos ----------
caja(40, 110, 360, 150, 'Navegador web', ['SPA React 19 + TypeScript (Vite)', 'Subastador y Comprador', 'Escritorio y móvil'], 'device')
caja(160, 360, 240, 120, 'Vercel Edge CDN', ['cafeorbe-web', 'cafeorbe-web.vercel.app'], 'executionEnvironment', AZUL)
caja(160, 580, 240, 120, 'Google Identity', ['OAuth2 / OIDC', 'ID token y JWKS'], 'externalSystem', AZUL)
caja(40, 820, 360, 130, 'LiveKit Cloud SFU', ['Video WebRTC del subastador', 'Webhooks firmados (HTTPS)'], 'externalSystem', AZUL)

# ---------- Azure ----------
grupo(470, 80, 1440, 1360, 'Microsoft Azure · grupo de recursos cafeorbe-org (East US 2)', VERDE, '#f4f8f5')

# Red del balanceador
grupo(500, 125, 1380, 300, 'Red virtual cafeorbe-lb-vnet · NSG cafeorbe-lb-nsg (entrada web desde Internet)', CAFE, '#fbf6ef')
caja(530, 190, 400, 210, 'Azure Load Balancer Standard', ['cafeorbe-lb · IP pública estática', 'cafeorbe-lb.eastus2.cloudapp.azure.com',
     'Reglas tcp-443 y tcp-80 (hash 5 tuplas)', 'Sonda HTTP /lb/salud cada 5 s', 'Regla de salida «salida»'], 'loadBalancer', CAFE, tam=16)
for i, (n, yy) in enumerate((('cafeorbe-lb-vm1', 175), ('cafeorbe-lb-vm2', 305))):
    caja(1040, yy, 420, 108, f'VM {i+1} · {n}', ['Standard_D2s_v3 · Ubuntu 24.04 LTS', 'NGINX: TLS (Let\'s Encrypt), REST y /ws/'], 'device', CAFE, tam=15.5)
out.append(f'<text x="1500" y="205" font-size="13.5" fill="{CAFE}">Grupo de back-end «vms»</text>')
out.append(f'<text x="1500" y="228" font-size="13.5" fill="{CAFE}">Si una VM falla la sonda,</text>')
out.append(f'<text x="1500" y="249" font-size="13.5" fill="{CAFE}">sale del reparto en ~10 s.</text>')
out.append(f'<text x="1500" y="282" font-size="13.5" fill="{CAFE}">NGINX resuelve el destino en</text>')
out.append(f'<text x="1500" y="303" font-size="13.5" fill="{CAFE}">cada petición (resolver de Azure).</text>')
out.append(f'<text x="1500" y="336" font-size="13.5" fill="{CAFE}">Destino actual: ambiente QA</text>')
out.append(f'<text x="1500" y="357" font-size="13.5" fill="{CAFE}">(scripts/balanceador-azure.sh).</text>')

# Container Apps QA
grupo(500, 460, 1380, 520, 'Azure Container Apps · ambiente cafeorbe-qa (Consumption) · ingress HTTPS con balanceo entre réplicas y sondas de salud', VERDE, '#ffffff')
caja(560, 520, 470, 120, 'api-gateway', ['Spring Cloud Gateway · :8080', '2–4 réplicas × 0,25 vCPU · escala HTTP 20', 'JWT, CORS, rate limit, correlationId'], 'container')
caja(1180, 520, 470, 120, 'realtime-gateway', ['WebSocket · hilos virtuales · :8085', '2–4 réplicas × 0,5 vCPU · escala HTTP 20', 'Ticket 1 uso, límite de pujas, Redis Pub/Sub'], 'container')
dom = [('streaming-service', [':8084 · 1–2 × 0,25 vCPU', 'Salas LiveKit, token RTC']),
       ('identity-service', [':8081 · 1–2 × 0,25 vCPU', 'Google, JWT y tickets WS']),
       ('auction-service', [':8082 · 2–4 × 0,5 vCPU', 'Escala HTTP 12 · Outbox', 'Bloqueo de fila, cierre']),
       ('wallet-service', [':8083 · 1–2 × 0,5 vCPU', 'Ledger de Orbes']),
       ]
xs = [530, 870, 1210, 1550]
for (n, ls), x in zip(dom, xs):
    caja(x, 745, 300, 140, n, ls, 'container', tam=16)
# bus interno del api-gateway
flecha([(795, 640), (795, 700), (680, 700), (680, 745)], color=VERDE)
for x in (1020, 1360, 1700):
    flecha([(795, 700), (x, 700), (x, 745)], color=VERDE)
out.append(f'<text x="830" y="692" font-size="13" font-weight="600" fill="{VERDE}">REST interno + X-Internal-Token + X-Correlation-Id</text>')
flecha([(1415, 640), (1415, 745)], 'POST puja', VERDE, lx=1470, ly=730)
flecha([(1510, 830), (1550, 830)], color=VERDE)
out.append(f'<text x="1500" y="912" font-size="13" font-weight="600" fill="{VERDE}">auction → wallet: saldo (timeout 2 s)</text>')
out.append(f'<text x="530" y="960" font-size="13.5" fill="{GRIS}">Imágenes etiquetadas con el commit de main · réplicas mínimas siempre encendidas (sin arranque en frío) · DB_POOL_MAX=4 en auction</text>')

# Datos
caja(530, 1050, 430, 170, 'Azure Database for PostgreSQL', ['Flexible Server cafeorbe-pg · v18', 'Standard_B1ms · Central US · TLS 5432',
     'identity_db · auction_db', 'wallet_db · streaming_db'], 'database', MORADO, tam=16)
caja(1010, 1050, 400, 170, 'Azure Cache for Redis', ['cafeorbe-redis · Basic C0 · 6.0', 'Solo TLS 6380',
     'Tickets WS, sesiones cerradas,', 'rate limit y Pub/Sub de salas'], 'database', MORADO, tam=16)
caja(1460, 1050, 400, 170, 'Azure Log Analytics', ['Área de trabajo cafeorbe-logs', 'ContainerAppConsoleLogs_CL',
     'Logs JSON con correlationId', '(QA y PROD)'], 'executionEnvironment', MORADO, tam=16)
flecha([(745, 980), (745, 1050)], 'JDBC/TLS', MORADO, lx=800, ly=1020)
flecha([(1210, 980), (1210, 1050)], 'TLS 6380', MORADO, lx=1260, ly=1020)
flecha([(1660, 980), (1660, 1050)], 'stdout JSON', MORADO, lx=1720, ly=1020)

caja(530, 1290, 430, 120, 'Azure Container Registry', ['cafeorbeacr.azurecr.io · Basic', 'Imágenes de los 6 servicios'], 'artifact', GRIS, tam=16)
caja(1010, 1290, 850, 120, 'Ambiente cafeorbe-prod (misma topología)', ['api-gateway-prod, realtime-gateway-prod y auction-service-prod: 2–4 réplicas',
     'Redis cafeorbe-redis-prod · PostgreSQL cafeorbe-pg-prod · despliegue con tag v*'], 'executionEnvironment', GRIS, tam=16)

# ---------- Columna derecha ----------
caja(1990, 500, 370, 150, 'CloudAMQP (RabbitMQ)', ['Broker gestionado', 'AMQPS 5671 · confirmaciones', 'Eventos del Outbox (at-least-once)'], 'externalSystem', AZUL)
caja(1990, 740, 370, 150, 'Grafana Cloud', ['Métricas OTLP cada 10 s', 'Tableros Negocio y Técnico', 'Alertas (Réplica caída, abuso)'], 'externalSystem', AZUL)
caja(1990, 1040, 370, 180, 'GitHub Actions', ['8 repositorios · main protegida', 'Pull request + check ci', '+ 1 aprobación', 'SonarQube Cloud (Quality Gate)'], 'executionEnvironment', AZUL)

# ---------- Conexiones externas ----------
flecha([(280, 260), (280, 360)], 'HTTPS: descarga la SPA', AZUL, lx=290, ly=318, ancla='start')
flecha([(125, 260), (125, 640), (160, 640)], 'Sign-In\nID token', AZUL, lx=100, ly=520, ancla='start')
flecha([(80, 260), (80, 820)], color=AZUL, guion=True, doble=True)
out.append(f'<text x="58" y="790" font-size="13" font-weight="600" fill="{AZUL}" transform="rotate(-90 58 790)">WebRTC (video en vivo)</text>')
flecha([(400, 185), (530, 260)], 'HTTPS REST + WSS (443)', CAFE, lx=470, ly=170)
flecha([(930, 260), (1040, 228)], 'TCP 443/80', CAFE, lx=985, ly=232)
flecha([(930, 330), (1040, 358)], color=CAFE)
flecha([(1250, 413), (1250, 450), (795, 450), (795, 520)], 'REST  /api/*', CAFE, lx=930, ly=444)
flecha([(1350, 413), (1350, 450), (1415, 450), (1415, 520)], 'WSS  /ws/*', CAFE, lx=1470, ly=444)
flecha([(530, 850), (412, 900)], 'API LiveKit · token RTC', AZUL, lx=418, ly=975, ancla='start')
flecha([(412, 925), (470, 925), (470, 580), (560, 580)], 'webhooks', AZUL, guion=True, lx=515, ly=605)
flecha([(870, 800), (856, 800), (856, 1000), (432, 1000), (432, 660), (400, 660)], 'JWKS de Google', AZUL, guion=True, lx=440, ly=1030, ancla='start')
flecha([(1880, 575), (1990, 575)], 'AMQPS 5671', AZUL, lx=1935, ly=560)
flecha([(1880, 815), (1990, 815)], 'OTLP', AZUL, lx=1935, ly=800)
flecha([(1990, 1200), (1950, 1200), (1950, 1460), (745, 1460), (745, 1410)], 'docker push (imagen del commit)', GRIS, lx=1350, ly=1453)
flecha([(960, 1350), (985, 1350), (985, 1000), (1000, 1000), (1000, 980)], color=GRIS, guion=True)
out.append(f'<text x="2000" y="1265" font-size="13" fill="{GRIS}">az containerapp update en QA (push a main)</text>')
out.append(f'<text x="2000" y="1284" font-size="13" fill="{GRIS}">y en PROD (tag v*)</text>')

svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Segoe UI, Arial, sans-serif">'
       '<defs><marker id="fin" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>'
       '<marker id="ini" markerWidth="10" markerHeight="10" refX="1" refY="5" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="context-stroke"/></marker></defs>'
       f'<rect width="{W}" height="{H}" fill="#fffaf2"/>' + ''.join(out) + '</svg>')
html = ('<!doctype html><html><head><meta charset="utf-8"><title>Diagrama de despliegue CaféOrbe</title>'
        '<style>html,body{margin:0;padding:0;background:#fffaf2}</style></head><body>' + svg + '</body></html>')
aqui = Path(__file__).parent
(aqui / 'diagrama-despliegue.svg').write_text(svg, encoding='utf-8')
(aqui / 'diagrama-despliegue.html').write_text(html, encoding='utf-8')
print('ok')
