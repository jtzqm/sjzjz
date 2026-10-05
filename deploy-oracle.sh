#!/usr/bin/env bash
# ============================================================================
# 三角洲记账系统 · 免费云部署脚本（Oracle Cloud Always-Free ARM 实例 / Ubuntu 22.04）
# 适用：你有 Oracle 永久免费实例（如已有的大阪 ARM 机），把本系统跑在上面。
# 解决两个硬约束：
#   1) better-sqlite3 是原生模块 —— 在 VM 上用系统 Node + 官方预编译包即可，无需折腾。
#   2) SQLite 文件(data/delta.db) 需要持久盘 —— VM 自带持久块存储，重启不丢数据。
# 运行方式：把本仓库传到实例后，sudo bash deploy-oracle.sh
# ============================================================================
set -e

APP_DIR="/opt/delta-accounting"
APP_USER="delta"
PORT=3000

echo "==> 1/7 安装 Node.js 22（ARM64 官方源）"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get update -y
apt-get install -y nodejs

echo "==> 2/7 创建专用运行用户与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
cp -r "$(dirname "$0")/." "$APP_DIR/" 2>/dev/null || true
# 若你是 git clone 进来的，确保源码在 $APP_DIR；上面的 cp 假设脚本与源码同目录。
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> 3/7 安装依赖（含原生 better-sqlite3，自动拉 linux-arm64 预编译包）"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev
# 说明：tesseract.js 已挪到 devDependencies（OCR 在浏览器端跑，服务器不需要）

echo "==> 4/7 生成环境配置 .env（请务必改掉下面的默认值！）"
cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
SESSION_SECRET=$(openssl rand -hex 32)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$(openssl rand -base64 12)
EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
echo "    管理员初始账号已写入 .env（admin / 随机密码），部署后请登录并改密。"

echo "==> 5/7 注册 systemd 服务（开机自启 + 崩溃自动重启，保证程序正常运行）"
cat > /etc/systemd/system/delta-accounting.service <<EOF
[Unit]
Description=Delta Accounting System
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node $APP_DIR/server.js
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

echo "==> 6/8 远程访问：Cloudflare Tunnel（你已有托管域名，用命名隧道，免费+自动HTTPS+不用开端口）"
echo "  1) 装 cloudflared："
echo "     curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared"
echo "     chmod +x /usr/local/bin/cloudflared"
echo "  2) 登录并选你的域名（浏览器操作，Cloudflare 下发证书到 ~/.cloudflared/cert.pem）："
echo "     cloudflared tunnel login"
echo "  3) 建命名隧道（记下输出的 TUNNEL_ID）："
echo "     cloudflared tunnel create delta-app"
echo "  4) 填配置：把 cloudflared-config.yml.example 改成你的域名+TUNNEL_ID，放到 ~/.cloudflared/config.yml"
echo "  5) 自动建 DNS（Cloudflare 上加一条 CNAME 指向隧道）："
echo "     cloudflared tunnel route dns delta-app delta.yourdomain.com"
echo "  6) 常驻服务（开机自启）："
echo "     cloudflared service install"
echo "  验证：curl -sS https://delta.yourdomain.com/login"
echo "  （可选增强：在 Cloudflare Zero Trust 给 /login 后台加 Access 策略，仅放你的邮箱，避免后台被扫。）"

echo "==> 7/8 自动备份（服务器端每日热备，保证 WAL 模式下数据一致）"
cp "$APP_DIR/backup.js" /usr/local/bin/delta-backup.js 2>/dev/null || true
# 若 backup.js 与源码同目录则已在 $APP_DIR，直接用
cat > /etc/cron.d/delta-backup <<EOF
0 4 * * * $APP_USER /usr/bin/node $APP_DIR/backup.js >> $APP_DIR/backups/backup.log 2>&1
EOF
echo "  已加入 cron：每天 04:00 生成一致性快照到 $APP_DIR/backups/delta-latest.db"

echo "==> 8/8 完成"
echo "  本地健康检查：curl -sS http://localhost:$PORT/login"
echo "  客户查询入口（免登录）：https://delta.yourdomain.com/public/track"
echo "  客户输入：订单号(order_number) + 验证码(query_token，建单时自动生成)"
echo "  后台管理：https://delta.yourdomain.com/login （用 .env 里的 admin 登录）"
echo "  本地全量备份：在 Windows 上用任务计划程序跑 sync-from-windows.ps1（每日拉取 delta-latest.db）"
