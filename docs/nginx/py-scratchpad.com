# /etc/nginx/sites-available/py-scratchpad.com
# Managed by 0xWulf / HexaWulf homelab
# Reverse proxy for py-scratchpad on the app host, port 5040 — the public home of the app.
# TEMPLATE: the proxy_pass address below is filled in by envsubst at install time
# (docs/DEPLOY.md §6.2). Installed as-is, nginx -t rejects it as an unknown variable.
# Created: 2026-10-09
#
# Backend and proxy block were copied from python.piapps.dev, the original
# host, which was retired on 2026-11-25. This is now the only public vhost.
#
# The www -> apex redirect uses a separate server block rather than `if ($host = ...)`.
#
# TLS: dedicated cert py-scratchpad.com (SAN apex + www), ECDSA P-256,
# issued HTTP-01 via webroot /var/www/letsencrypt (not the DNS-01 wildcard
# path used by piapps.dev).
#
# Every block includes the ACME snippet, and every redirect lives in a
# `location /` rather than at server level. That is deliberate: nginx runs a
# server-level `return 301` in the server-rewrite phase, before location
# selection, which makes `location ^~ /.well-known/acme-challenge/`
# unreachable.
# In the apex block the snippet's `^~` prefix outranks both the proxy
# `location /` and the dotfile regex, so challenges are served from the
# webroot while everything else proxies.
#
# No add_header anywhere in this file. The container owns the security headers
# (docker/security-headers.conf) and nothing on the edge host adds headers at http
# level, in conf.d/ or in snippets/, so an add_header here would make each one
# appear twice on the public URL. cloudflare_real_ip.conf is likewise already
# loaded at http level — do not include it per-vhost.

# --- HTTP (both names) -> HTTPS apex, one hop
server {
    listen 80;
    listen [::]:80;
    server_name py-scratchpad.com www.py-scratchpad.com;

    include /etc/nginx/snippets/acme-http-01.conf;

    access_log /var/log/nginx/py-scratchpad.com.access.log;
    error_log  /var/log/nginx/py-scratchpad.com.error.log;

    location / {
        return 301 https://py-scratchpad.com$request_uri;
    }
}

# --- HTTPS www -> apex
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name www.py-scratchpad.com;

    ssl_certificate     /etc/letsencrypt/live/py-scratchpad.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/py-scratchpad.com/privkey.pem;

    include /etc/nginx/snippets/acme-http-01.conf;

    access_log /var/log/nginx/py-scratchpad.com.access.log;
    error_log  /var/log/nginx/py-scratchpad.com.error.log;

    location / {
        return 301 https://py-scratchpad.com$request_uri;
    }
}

# --- HTTPS apex (the site)
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name py-scratchpad.com;

    ssl_certificate     /etc/letsencrypt/live/py-scratchpad.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/py-scratchpad.com/privkey.pem;

    include /etc/nginx/snippets/acme-http-01.conf;

    access_log /var/log/nginx/py-scratchpad.com.access.log;
    error_log  /var/log/nginx/py-scratchpad.com.error.log;

    client_max_body_size 1k;

    location ~ /\.(?!well-known(?:/|$)) {
        return 404;
    }

    location / {
        limit_except GET HEAD {
            deny all;
        }
        proxy_pass http://$APP_HOST_IP:5040;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering on;
        proxy_cache off;
        proxy_connect_timeout 5s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
    }
}
