# Static web platform. The design is served as-is; the gateway is reachable at
# /api on the same origin so the page needs no cross-origin configuration.
FROM nginx:1.27-alpine
COPY index.html /usr/share/nginx/html/index.html
COPY app.js /usr/share/nginx/html/app.js
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
