#!/usr/bin/env bash
# ============================================================================
# 配置 Cloudflare Tunnel —— 只把「客户查询」暴露到公网
#
# 设计原则：最小暴露面
#   放行：/public/*（客户查询、二维码、打印派单）+ /styles.css（样式表）
#   拦截：后台 /login、/orders、打手端 /booster... 一律不出公网
#
# 前提：
#   1) 域名已托管在 Cloudflare（Nameservers 指向 Cloudflare）
#   2) 本机已能出网（隧道是主动出向，不需要公网 IP，也不需要 DDNS）
#
# 运行方式：sudo bash setup-tunnel.sh
# ============================================================================
set -e

APP_DIR="/opt/delta-accounting"
PORT=3000
TUNNEL_NAME="delta-track"
CF_DIR="/root/.cloudflared"

if [ "$(id -u)" != "0" ]; then
  echo "请用 root 运行：sudo bash $0"
  exit 1
fi

echo "==> 1/6 安装 cloudflared"
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
  armv7l|armv6l) CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm" ;;
  x86_64|amd64)  CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
  *) echo "未识别架构: $ARCH"; exit 1 ;;
esac
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL "$CF_URL" -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
  echo "    已安装: $(cloudflared --version | head -1)"
else
  echo "    已存在: $(cloudflared --version | head -1)"
fi

echo "==> 2/6 登录 Cloudflare（会给出一个 URL，请在浏览器打开并选域名）"
if [ ! -f "$CF_DIR/cert.pem" ]; then
  mkdir -p "$CF_DIR"
  cloudflared tunnel login
else
  echo "    已登录（cert.pem 存在），跳过"
fi

echo "==> 3/6 创建命名隧道"
if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  echo "    隧道 $TUNNEL_NAME 已存在，复用"
else
  cloudflared tunnel create "$TUNNEL_NAME"
fi
TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1; exit}')"
if [ -z "$TUNNEL_ID" ]; then
  echo "    自动获取 TUNNEL_ID 失败，请从 'cloudflared tunnel list' 输出里手动复制"
  read -r -p "    TUNNEL_ID: " TUNNEL_ID
fi
echo "    TUNNEL_ID: $TUNNEL_ID"

echo "==> 4/6 填写客户查询域名"
echo "    例如 track.yourdomain.com（必须是 Cloudflare 托管的域名）"
read -r -p "    域名: " HOSTNAME
if [ -z "$HOSTNAME" ]; then
  echo "    未输入域名，退出"; exit 1
fi

mkdir -p "$CF_DIR"
cat > "$CF_DIR/config.yml" <<EOF
# Cloudflare Tunnel —— 仅暴露客户查询，后台与打手端不出公网
tunnel: $TUNNEL_ID
credentials-file: $CF_DIR/$TUNNEL_ID.json

ingress:
  # 客户查询页、二维码、打印派单
  - hostname: $HOSTNAME
    path: /public/*
    service: http://localhost:$PORT
  # 样式表挂在根路径，不放行会导致客户看到无样式的裸页面
  - hostname: $HOSTNAME
    path: /styles.css
    service: http://localhost:$PORT
  # 兜底：其它路径（后台 /login、/orders、打手端）一律 404
  - service: http_status:404
EOF
echo "    已写入 $CF_DIR/config.yml"

echo "==> 5/6 创建 DNS 记录并常驻"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || echo "    DNS 记录可能已存在，忽略"
cloudflared service install || echo "    service install 失败，可用 'cloudflared tunnel run' 前台运行"
systemctl enable cloudflared 2>/dev/null || true
systemctl restart cloudflared 2>/dev/null || true
sleep 3

echo "==> 6/6 把公网地址写进 .env（否则二维码会编成内网地址，客户扫不开）"
if [ -f "$APP_DIR/.env" ]; then
  if grep -q '^PUBLIC_BASE_URL=' "$APP_DIR/.env"; then
    sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$HOSTNAME|" "$APP_DIR/.env"
  else
    echo "PUBLIC_BASE_URL=https://$HOSTNAME" >> "$APP_DIR/.env"
  fi
  systemctl restart delta-accounting 2>/dev/null || true
  echo "    已设置 PUBLIC_BASE_URL=https://$HOSTNAME 并重启服务"
else
  echo "    未找到 $APP_DIR/.env，请手动添加：PUBLIC_BASE_URL=https://$HOSTNAME"
fi

echo ""
echo "============================================================"
echo "  完成。请验证："
echo "    公网客户查询: https://$HOSTNAME/public/track   （应正常打开）"
echo "    公网后台:     https://$HOSTNAME/login          （应为 404，说明未暴露）"
echo "    内网打手端:   http://<内网IP>:$PORT            （不受隧道影响）"
echo ""
echo "  提醒：Cloudflare 从中国大陆访问速度不稳定，请让国内朋友实测。"
echo "        若打不开或太慢，退路是换国内小 VPS 跑 frp 中转。"
echo "============================================================"
