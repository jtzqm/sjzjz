#!/usr/bin/env bash
# ============================================================================
# 三角洲记账系统 · Armbian / Debian 内网部署脚本（推荐场景）
#
# 适用：机器放在办公场地，打手和服务器在同一个 WiFi 下：
#         - 打手端      -> 内网直连 http://<内网IP>:3000   （零延迟、断外网也能用）
#         - 客户查询    -> Cloudflare Tunnel 只暴露 /public/* 与 /styles.css
#         - 后台/打手端 -> 不出公网，攻击面最小
#
# 为什么不需要公网 IP / DDNS：
#   Cloudflare Tunnel 是服务器主动出向连边缘节点，不需要任何入向通道，
#   所以既不需要公网 IPv4，也不需要 DDNS（DDNS 的前提恰恰是"有公网 IP"）。
#
# 运行方式：sudo bash deploy-armbian.sh
# ============================================================================
set -e

APP_DIR="/opt/delta-accounting"
APP_USER="delta"
PORT=3000
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"

if [ "$(id -u)" != "0" ]; then
  echo "请用 root 运行：sudo bash $0"
  exit 1
fi

ARCH="$(uname -m)"
echo "==> 0/7 环境检查"
echo "    架构: $ARCH   内存: $(free -h 2>/dev/null | awk '/^Mem:/{print $2}' || echo unknown)"
echo "    系统: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo unknown)"
if [ "$ARCH" = "armv7l" ] || [ "$ARCH" = "armv6l" ]; then
  echo "    ARM 32 位：better-sqlite3 多半要本地编译，1GB 内存的板子可能要十几分钟"
fi

echo "==> 1/7 安装 Node.js 22"
apt-get update -y
if ! command -v node >/dev/null 2>&1; then
  apt-get install -y curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "    Node: $NODE_BIN ($(node -v))"

echo "==> 2/7 安装编译工具链（better-sqlite3 无预编译包时自动本地编译）"
apt-get install -y build-essential python3 make g++ || echo "    [warn] 工具链安装失败，若 npm install 报错请手动安装"

echo "==> 3/7 创建运行用户与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$APP_USER"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
  tar -C "$SRC_DIR" --exclude=./node_modules --exclude=./data --exclude=./backups --exclude=./.git -cf - . | tar -C "$APP_DIR" -xf -
fi
# 关键：data/ 被 .gitignore 排除，克隆下来不存在，而 database.js 不会自建目录。
# 缺失时 better-sqlite3 直接抛 "Cannot open database because the directory does not exist"。
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
echo "    已确保 $APP_DIR/data 存在"

echo "==> 4/7 安装依赖（首次编译可能较慢，请勿中断）"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev

echo "==> 5/7 生成环境配置 .env"
if [ -f "$APP_DIR/.env" ]; then
  echo "    .env 已存在，保留不覆盖（管理员密码不会丢）"
  grep -q '^PUBLIC_BASE_URL=' "$APP_DIR/.env" || echo "PUBLIC_BASE_URL=$PUBLIC_BASE_URL" >> "$APP_DIR/.env"
else
  cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
SESSION_SECRET=$(openssl rand -hex 32)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$(openssl rand -base64 12)
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
EOF
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
echo "    管理员账号：$(grep '^ADMIN_USERNAME=' "$APP_DIR/.env" | cut -d= -f2)"
echo "    管理员密码：$(grep '^ADMIN_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2)"
echo "    >>> 登录后请立即修改密码 <<<"

echo "==> 6/7 注册 systemd 服务（开机自启 + 崩溃自动重启）"
cat > /etc/systemd/system/delta-accounting.service <<EOF
[Unit]
Description=Delta Accounting System
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable delta-accounting
systemctl restart delta-accounting
sleep 3
systemctl is-active --quiet delta-accounting && echo "    服务运行中" || {
  echo "    服务未起来，日志如下："; journalctl -u delta-accounting -n 20 --no-pager; exit 1;
}

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}')"
[ -z "$LAN_IP" ] && LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo "==> 7/7 自动备份（每日 04:00 热备，保证 WAL 模式下数据一致）"
cat > /etc/cron.d/delta-backup <<EOF
0 4 * * * $APP_USER $NODE_BIN $APP_DIR/backup.js >> $APP_DIR/backups/backup.log 2>&1
EOF

echo ""
echo "============================================================"
echo "  部署完成"
echo "============================================================"
echo "  打手/后台访问（同一 WiFi 内网直连）："
echo "      http://${LAN_IP:-<内网IP>}:3000"
echo ""
echo "  健康检查： curl -sS http://localhost:$PORT/login"
echo "  服务日志： journalctl -u delta-accounting -f"
echo ""
echo "  [重要] 请在路由器里给这台机器做 MAC 绑定 / 静态 IP，"
echo "         否则重启后内网 IP 变了，所有打手的书签都会失效。"
echo "============================================================"
echo ""
echo "  客户（国内）需要从公网访问时，再配 Cloudflare Tunnel："
echo "    bash $APP_DIR/setup-tunnel.sh"
echo "  或按 README 里的手工步骤操作。"
echo "  注意：隧道只需暴露 /public/* 与 /styles.css，后台一律不出公网。"
