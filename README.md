# 三角洲跑刀代练记账系统

一套给「游戏代练工作室」用的订单与账目管理系统：管理员派单、打手上报进度、客户免登录查进度。

核心特色是**截图 OCR 识别**：打手上传游戏截图后，系统在**浏览器内**自动识别出「总资产」数字并填入表单，**截图不会上传到服务器**。

---

## 一、适合什么系统

| 层面 | 要求 |
|---|---|
| **服务器系统** | Linux（Debian / Ubuntu / Armbian）推荐；Windows 也可本地直接跑 |
| **运行时** | Node.js 18+（脚本默认装 22） |
| **数据库** | SQLite 3（内置，无需单独安装数据库服务） |
| **浏览器** | 任意现代浏览器，Chrome / Edge / Safari 均可 |
| **打手端设备** | **手机浏览器即可**（OCR 在手机本地跑，不用装 App） |
| **硬件** | 极低。1 核 1GB 内存的 Armbian 小主机足够 |

> 说明：`better-sqlite3` 是原生模块。ARM64 通常能直接拉到官方预编译包；
> ARM 32 位（armv7l）或冷门架构需要本地编译，部署脚本已自动装好编译工具链。

---

## 二、核心业务流程

```
管理员建单（需求 M 数、客户、打手）
   ↓
打手上传「开始截图」→ 浏览器 OCR 识别开局总资产
   ↓
打手上传「结束截图」→ 浏览器 OCR 识别收尾总资产
   ↓
系统算出本轮变动、累计进度、剩余量
   ↓
客户凭「订单号 + 验证码」免登录查询进度（可扫码、可打印派单）
```

---

## 三、功能清单

**订单**
- 新建 / 编辑 / 删除 / 完成 / 重新激活；自动订单号
- 进行中订单、已完成订单分开管理
- 订单详情、打印派单

**打手端**
- 只看到派给自己的单，越权访问一律 403
- 上传开始/结束截图，**浏览器内 OCR 自动识别总资产**
- 手动框选识别区域（版式固定，区域会被记住）

**客户查询（免登录）**
- 客户凭订单号 + 验证码查进度
- 生成查询二维码，可直接发给客户扫码
- 客户可打印派单

**账目**
- 交易记录、收款记录（含状态标记）
- 客户管理、微信/手机号管理、俱乐部管理
- 统计页

**系统**
- 三种角色：管理员 / 打手 / 客户（公开查询）
- 用户注册审核（approve / reject / verify）
- 管理员可创建、禁用、重置打手账号
- 数据库备份与恢复（页面内可一键备份/下载/恢复）

---

## 四、OCR 说明（重要）

- 引擎：**Tesseract 5（LSTM）**，以 WASM 形式在**浏览器内**运行
- 识别范围：单行数字，字符白名单锁定为 `0123456789.,MKB`
- **隐私**：服务端没有任何 OCR 代码，也没有图片上传接口。截图**从头到尾不离开打手的设备**，服务器只收到一个数字
- 已做的优化：SIMD 核心探测、worker 复用（避免逐行重复加载 15MB 引擎）、Otsu 自适应二值化、低置信度提示
- 语言包：`public/ocr/lang/eng.traineddata.gz` 已在仓库内，**离线可用**

---

## 五、快速开始

### A. Windows 本地（最简单）

1. 双击 `start.bat`
2. 浏览器打开 <http://localhost:3000>
3. 用管理员账号登录

> 脚本会优先使用项目自带的 `nodejs\node-v22.14.0-win-x64`（该目录未入库，克隆仓库时需自备 Node）。
> 窗口要一直开着，关掉即停服。

### B. Linux 服务器（推荐生产使用）

```bash
git clone https://github.com/jtzqm/sjzjz.git
cd sjzjz
sudo bash deploy-armbian.sh     # 内网/办公室场景（见下）
# 或
sudo bash deploy-oracle.sh      # 云服务器公网场景
```

脚本会自动完成：装 Node 22 → 装编译工具链 → 建运行用户 → **创建 `data/` 目录** → 安装依赖 → 生成 `.env`（随机管理员密码）→ 注册 systemd 开机自启 → 每日 04:00 自动备份。

部署完看输出里的管理员账号密码，**登录后立即改密码**。

常用命令：

```bash
systemctl status delta-accounting     # 查看状态
journalctl -u delta-accounting -f     # 看日志
systemctl restart delta-accounting    # 重启
```

---

## 六、两种部署场景，怎么选

### 场景 1：机器在办公室 / 家里（推荐，大多数工作室）

**打手和服务器在同一个 WiFi 下** —— 这是最省事的方案：

| 使用者 | 访问方式 |
|---|---|
| 打手、管理员 | `http://<内网IP>:3000` 内网直连，**零延迟、断外网也能用** |
| 客户（异地） | Cloudflare Tunnel，只暴露客户查询页 |

```bash
sudo bash deploy-armbian.sh
```

部署后**务必在路由器里给这台机器做 MAC 绑定 / 静态 IP**，否则重启后 IP 变了，所有打手的书签都会失效。

### 场景 2：云服务器（有公网出口）

```bash
sudo bash deploy-oracle.sh
```

适合 Oracle Cloud 免费 ARM 实例、各类 VPS。

---

## 七、让异地客户访问（Cloudflare Tunnel）

### 为什么不需要公网 IP，也不需要 DDNS

| 方案 | 前提 | CGNAT 环境下 |
|---|---|---|
| IPv4 DDNS | 需要公网 IPv4 | ❌ A 记录只会解析到运营商 NAT 出口，数据包到不了你 |
| IPv6 DDNS | 需要公网 IPv6 | ❌ 两端都没有 IPv6 时无效 |
| **Cloudflare Tunnel** | **什么都不需要** | ✅ 唯一可行 |

隧道是**服务器主动出向**连 Cloudflare 边缘节点，不需要任何入向通道。
所以：**正因为没有公网 IP，DDNS 才无效；而隧道恰恰因此才必要。**

### 配置（只暴露客户查询，后台不出公网）

```bash
sudo bash setup-tunnel.sh
```

按提示完成 Cloudflare 登录、输入域名即可。生成的配置只放行：

```yaml
ingress:
  - hostname: track.yourdomain.com
    path: /public/*        # 客户查询、二维码、打印派单
    service: http://localhost:3000
  - hostname: track.yourdomain.com
    path: /styles.css      # 样式表，不放行会导致客户看到无样式裸页面
    service: http://localhost:3000
  - service: http_status:404   # 后台 /login、/orders、打手端一律拦截
```

**关键一步**：隧道配好后，把公网地址写进 `.env`，否则打手在内网生成的二维码会编码成 `http://192.168.x.x:3000/...`，客户扫码打不开。

```bash
echo 'PUBLIC_BASE_URL=https://track.yourdomain.com' >> /opt/delta-accounting/.env
systemctl restart delta-accounting
```

`setup-tunnel.sh` 会自动做这一步。

> ⚠️ Cloudflare 从中国大陆访问速度不稳定。请让国内朋友实测；
> 若打不开或太慢，退路是换一台国内小 VPS 跑 frp 中转。
> Cloudflare 在乌干达坎帕拉（Kampala / EBB）有边缘节点，本地访问质量较好。

---

## 八、配置项（`.env`）

| 变量 | 说明 |
|---|---|
| `PORT` | 端口，默认 3000 |
| `SESSION_SECRET` | 会话密钥，部署脚本自动生成随机值 |
| `ADMIN_USERNAME` | 初始管理员账号 |
| `ADMIN_PASSWORD` | 初始管理员密码（**登录后立即修改**） |
| `PUBLIC_BASE_URL` | 客户从公网访问的地址，用于生成二维码。**公网部署必填** |

`.env` 不会被提交到仓库（已在 `.gitignore` 中）。参考 `.env.example`。

---

## 九、备份与恢复

- 服务器每天 04:00 自动生成一致性快照到 `backups/`
- 管理界面「备份」页可手动创建、下载、恢复
- 数据库是 SQLite（WAL 模式）。**要拷贝数据库文件时，务必先停服或用备份功能生成快照**，只拷 `.db` 会漏掉未落盘的 `-wal` 文件

---

## 十、已知注意事项

1. **`data/` 目录必须存在** —— 它被 `.gitignore` 排除，而程序不会自建目录。缺失时启动会报
   `Cannot open database because the directory does not exist`。部署脚本已处理，手工部署时需 `mkdir -p data`。
2. **管理员密码有默认值** —— `server.js` 里的 `delta-session-secret-2026-change-me` 只是占位符，生产环境必须改。
3. **打手账号命名规则** —— 建议部署后自行调整，不要沿用公开仓库里的默认规则。
4. **ARM 32 位编译慢** —— `better-sqlite3` 本地编译可能要十几分钟，属于正常现象。

---

## 十一、仓库里不含什么

以下均已被 `.gitignore` 排除，**不会出现在仓库中**：

- `data/` —— 客户账目数据库
- `backups/` —— 数据库备份
- `.env` —— 凭据配置
- `nodejs/` —— Windows 版 Node 运行时（约 80MB）
- `node_modules/`

克隆下来是干净的源码，不含任何客户数据。

---

## 十二、目录结构（简）

```
server.js           主服务（Express + EJS）
database.js         SQLite 初始化
seed.js             初始管理员与基础数据
backup.js           备份脚本（cron 调用）
middleware/auth.js  登录与角色校验
public/booster-ocr.js   打手端 OCR 全部逻辑（浏览器端）
public/ocr/             Tesseract 引擎与语言包（离线）
views/                 页面模板
deploy-armbian.sh      内网/办公室部署脚本
deploy-oracle.sh       云服务器部署脚本
setup-tunnel.sh        Cloudflare Tunnel 配置脚本（最小暴露面）
start.bat              Windows 一键启动
```

---

## 十三、许可与免责

本项目为自用业务系统，代码以现状提供。使用前请自行评估并修改默认凭据。
