#!/bin/bash
# webutils 评审式链路（静态零容器应用）：
#   Chrome(host) --https--> nginx(host, 127.0.0.5:443, 补 Lzc-Api-Auth-Token)
#        --http--> lzc-ingress(172.18.0.1:80) --> 应用
#
# 为什么要带 Lzc-Api-Auth-Token：盒子上的浏览器注入（browser 阶段 inject）只在平台认到
# 会话时才启用。无票据时 /_lzc/injects/dynamic_params.json 只返回 {"ok":true,"safe_uid":""}，
# 注入脚本被注册但 __lzcRuntimeEnabled() 为 false，官方网盘选择器不会初始化。
# 因此本链路用 hc api_auth_token gen 生成的令牌补在请求头上，复刻"评审员已登录"的状态。
#
# 端口占用：perler-beads 用 127.0.0.3，ziwei 用 .2，musicblocks 用 .4，本应用用 .5。
set -u
export DOCKER_HOST=unix:///lzcsys/run/lzc-docker/docker.sock

DOMAIN="${DOMAIN:-webutils.wans.heiyu.space}"
BIND_IP="${BIND_IP:-127.0.0.5}"
CDP_PORT="${CDP_PORT:-9343}"
WORK="${WORK:-/root/wu-tkt}"
mkdir -p "$WORK"

TOKEN=$(hc api_auth_token gen 2>/dev/null | head -n1 | tr -d '\r\n')
if [ -z "$TOKEN" ]; then echo "TOKEN_EMPTY"; exit 1; fi
echo "token_len=${#TOKEN}"

if [ ! -f "$WORK/server.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -keyout "$WORK/server.key" -out "$WORK/server.crt" \
    -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" >/dev/null 2>&1
fi

cat > "$WORK/default.conf" <<EOF
server {
    listen ${BIND_IP}:443 ssl;
    server_name ${DOMAIN};
    ssl_certificate     /etc/nginx/tls/server.crt;
    ssl_certificate_key /etc/nginx/tls/server.key;
    client_max_body_size 512m;
    location / {
        proxy_pass http://172.18.0.1:80;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Lzc-Api-Auth-Token ${TOKEN};
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF

lzc-docker rm -f wu-tkt-tls wu-tkt-chrome >/dev/null 2>&1 || true
lzc-docker run -d --name wu-tkt-tls --network host \
  -v "$WORK/server.crt:/etc/nginx/tls/server.crt:ro" \
  -v "$WORK/server.key:/etc/nginx/tls/server.key:ro" \
  -v "$WORK/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  registry.lazycat.cloud/nginx:1.27.3 >/dev/null
sleep 2
lzc-docker ps --format '{{.Names}} {{.Status}}' | grep wu-tkt-tls || echo "TLS_NOT_RUNNING"

# 下载验收：把盒子上的 $WORK/downloads 挂进 Chrome 容器，验收脚本再把文件读回来核对
mkdir -p "$WORK/downloads"
chmod 777 "$WORK/downloads"

lzc-docker run -d --name wu-tkt-chrome --network host \
  -v "$WORK:/root/wu-tkt" \
  --entrypoint /usr/bin/google-chrome \
  registry.lazycat.cloud/yuan/linuxserver/chrome:e954e474726c1498 \
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port=${CDP_PORT} --remote-allow-origins='*' \
  --user-data-dir=/tmp/cdp-wu-tkt --ignore-certificate-errors \
  --window-size=1600,1000 \
  "--host-resolver-rules=MAP *.wans.heiyu.space ${BIND_IP}" \
  --lang=zh-CN --accept-lang=zh-CN,zh \
  about:blank >/dev/null
sleep 6
lzc-docker ps --format '{{.Names}} {{.Status}}' | grep wu-tkt-chrome || echo "CHROME_NOT_RUNNING"

echo "=== 前置自测 ==="
curl -sk "https://${BIND_IP}/_lzc/injects/dynamic_params.json?id=open-save-chooser" -H "Host: ${DOMAIN}" -o /tmp/wu-tkt-dyn.json -w "dynamic_params http=%{http_code}\n"
head -c 300 /tmp/wu-tkt-dyn.json; echo
curl -sk "https://${BIND_IP}/" -H "Host: ${DOMAIN}" -o /tmp/wu-tkt-index.html -w "index http=%{http_code} bytes=%{size_download}\n"
grep -oE "/_lzc/injects/[A-Za-z0-9_.-]+_0.js" /tmp/wu-tkt-index.html | sort -u | head -5
echo "WEBUTILS_TICKET_UP"
