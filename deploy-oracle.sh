#!/usr/bin/env bash
# ============================================================================
# 三角洲记账系统 · Linux 云服务器部署脚本（公网部署）
# 适用：Oracle Cloud Always-Free ARM / Ubuntu / Debian 等有公网出口的云主机
#
# 如果你的机器是放在内网（如办公室/家里的 Armbian 小主机），打手和服务器在
# 同一个 WiFi 下、只有客户需要从公网访问 —— 请用 deploy-armbian.sh，那个脚本
# 只把客户查询页暴露出去，后台和打手端不出公网。
#
# 运行方式：在源码目录下执行 sudo bash deploy-oracle.sh
# 可选环境变量：PUBLIC_BASE_URL=https://track.yourdomain.com  （客户访问地址）
# ============================================================================
set -e

APP_DIR="/opt/delta-accounting"
APP_USER="delta"
PORT=3000
# 客户从公网访问的地址，用于生成二维码。不设置则二维码会用请求的 Host 推断，
# 一旦在内网生成就会编出 192.168.x.x，客户扫码打不开。
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"

ARCH="$(uname -m)"
echo "==> 0/8 环境检查"
echo "    架构: $ARCH    系统: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo unknown)"
case "$ARCH" in
  aarch64|arm64) echo "    ARM64：better-sqlite3 通常能拉到官方预编译包" ;;
  armv7l|armv6l) echo "    ARM 32 位：大概率需要本地编译，耗时较长，请耐心等待" ;;
  x86_64|amd64)  echo "    x86_64：通常能拉到官方预编译包" ;;
  *)             echo "    未常见架构：将尝试本地编译" ;;
esac

echo "==> 1/8 安装 Node.js 22"
if ! command -v node >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "    Node: $NODE_BIN ($(node -v))"

echo "==> 2/8 安装编译工具链（better-sqlite3 无预编译包时自动本地编译）"
# better-sqlite3 的 install 脚本是 prebuild-install || node-gyp rebuild，
# 没有这套工具链时编译会直接失败，导致 npm install 中断。
apt-get install -y build-essential python3 make g++ || echo "    [warn] 工具链安装失败，若后续 npm install 报错请手动安装"

echo "==> 3/8 创建运行用户与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$APP_USER"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
  # 排除运行期数据与平台相关依赖：Windows 的 node_modules 在 Linux 上不可用
  tar -C "$SRC_DIR" --exclude=./node_modules --exclude=./data --exclude=./backups --exclude=./.git -cf - . | tar -C "$APP_DIR" -xf -
fi
# 关键：data/ 被 .gitignore 排除，克隆下来不存在；而 database.js 不会自建目录，
# 缺失时 better-sqlite3 直接抛 "Cannot open database because the directory does not exist"
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
echo "    已确保 $APP_DIR/data 存在"

echo "==> 4/8 安装依赖（含原生模块 better-sqlite3，首次编译可能较慢）"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev
# 说明：tesseract.js 在 devDependencies（OCR 在浏览器端跑，服务器不需要）

echo "==> 5/8 生成环境配置 .env"
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
  echo "    已生成随机管理员密码，见下方输出"
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
echo "    当前管理员账号：$(grep '^ADMIN_USERNAME=' "$APP_DIR/.env" | cut -d= -f2)"
echo "    当前管理员密码：$(grep '^ADMIN_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2)"
echo "    >>> 登录后请立即修改密码 <<<"

echo "==> 6/8 注册 systemd 服务（开机自启 + 崩溃自动重启）"
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
systemctl status delta-accounting --no-pager | head -n 8

echo "==> 7/8 远程访问：Cloudflare Tunnel（免费 + 自动 HTTPS + 无需公网 IP）"
echo "  1) 装 cloudflared（ARM64 用下面的链接，其它架构见 GitHub releases）："
echo "     curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared"
echo "     chmod +x /usr/local/bin/cloudflared"
echo "  2) 登录并选域名（浏览器操作，证书下发到 ~/.cloudflared/cert.pem）："
echo "     cloudflared tunnel login"
echo "  3) 建命名隧道（记下 TUNNEL_ID）："
echo "     cloudflared tunnel create delta-app"
echo "  4) 填配置：照 cloudflared-config.yml.example 改域名和 TUNNEL_ID，存到 ~/.cloudflared/config.yml"
echo "  5) 自动建 DNS（CNAME 指向隧道）："
echo "     cloudflared tunnel route dns delta-app delta.yourdomain.com"
echo "  6) 常驻：cloudflared service install"
echo "  7) 把公网地址写进 .env 的 PUBLIC_BASE_URL（否则二维码是内网地址），然后重启："
echo "     systemctl restart delta-accounting"
echo "  （可选：在 Cloudflare Zero Trust 给后台加 Access 策略，仅放你的邮箱，避免后台被扫）"

echo "==> 8/8 自动备份（每日热备，保证 WAL 模式下数据一致）"
mkdir -p "$APP_DIR/backups"
cat > /etc/cron.d/delta-backup <<EOF
0 4 * * * $APP_USER $NODE_BIN $APP_DIR/backup.js >> $APP_DIR/backups/backup.log 2>&1
EOF
echo "  已加入 cron：每天 04:00 生成一致性快照"

echo ""
echo "==> 完成"
echo "  本机健康检查：curl -sS http://localhost:$PORT/login"
echo "  服务日志：    journalctl -u delta-accounting -f"
echo "  客户查询入口：/public/track （免登录，客户输订单号 + 验证码）"
echo "  后台管理：    /login"
echo ""
if [ -z "$PUBLIC_BASE_URL" ]; then
  echo "  [提醒] 未设置 PUBLIC_BASE_URL，二维码将用访问者自己的地址生成。"
  echo "         公网部署请执行：echo 'PUBLIC_BASE_URL=https://你的域名' >> $APP_DIR/.env && systemctl restart delta-accounting"
fi
