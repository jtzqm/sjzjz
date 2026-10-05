# ============================================================================
# 本地 Windows 全量备份拉取脚本（配合服务器 backup.js 的 delta-latest.db）
# 用法：用「任务计划程序」每天定时跑本脚本（触发器→每天；操作→启动 powershell.exe -File 本路径）
# 前提：
#   1) Windows 已装 OpenSSH 客户端（设置→应用→可选功能→OpenSSH Client；或 WSL 里跑）
#   2) 已把本机公钥加到服务器 ~/.ssh/authorized_keys（免密，否则计划任务无法交互输密码）
# 方向说明：你的 Windows 在乌干达是 CGNAT，只能主动出向 —— 所以「本地拉云端」天然可行，
#           无需在云端开端口、也无需暴露 SSH 到公网。每次拉的是完整 db 文件 = 全量备份。
# ============================================================================

# ---- 按需修改 ----
$RemoteUser   = "delta"                       # 服务器运行用户（deploy 脚本建的）
$RemoteHost   = "161.33.40.188"               # Oracle 实例公网 IP
$RemoteFile   = "/opt/delta-accounting/backups/delta-latest.db"
$LocalDir     = "D:\delta-backup"             # 本地备份目录
$KeepDays     = 30                            # 本地保留天数
# ----------------

if (-not (Test-Path $LocalDir)) { New-Item -ItemType Directory -Path $LocalDir | Out-Null }

$ts       = Get-Date -Format "yyyyMMdd-HHmmss"
$localFile = Join-Path $LocalDir "delta-full-$ts.db"

# 全量拉取（每次都是完整文件）
scp "${RemoteUser}@${RemoteHost}:${RemoteFile}" $localFile
if ($LASTEXITCODE -ne 0) {
    Write-Error "SCP 拉取失败，请检查 SSH 密钥/网络"
    exit 1
}

# 清理本地过期备份
Get-ChildItem $LocalDir -Filter "delta-full-*.db" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
    Remove-Item -Force

Write-Host "已全量备份到 $localFile （本地保留 $KeepDays 天）"
