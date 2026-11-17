# CaféOrbe · balanceador de carga NGINX (DIS-01). Ver docs/BALANCEADOR.md.
FROM nginx:1.27.3-alpine

# El entrypoint oficial convierte /etc/nginx/templates/*.template en /etc/nginx/conf.d/*.conf con envsubst.
# El filtro evita que se sustituya cualquier otra variable de entorno.
ENV NGINX_ENVSUBST_FILTER="^(API|WS)_[AB]_HOST$"
RUN rm -f /etc/nginx/conf.d/default.conf
COPY templates/ /etc/nginx/templates/

EXPOSE 8080
