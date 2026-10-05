#!/usr/bin/env node
// ============================================================================
// 服务器端热备脚本：用 better-sqlite3 的在线 backup API 生成一致性快照。
// 关键：程序以 WAL 模式运行，直接 scp 拷贝 delta.db 可能不一致；
//       用 .backup() 会在不锁库的情况下产出一份完整一致的副本。
// 由 cron 每日调用（见 deploy-oracle.sh 的 /etc/cron.d/delta-backup）。
// 产出：backups/delta-YYYYMMDD-HHMMSS.db（按日归档）+ backups/delta-latest.db（供 Windows 拉取）
// ============================================================================
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || __dirname;
const SRC = path.join(APP_DIR, 'data', 'delta.db');
const BAK_DIR = path.join(APP_DIR, 'backups');
fs.mkdirSync(BAK_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(BAK_DIR, `delta-${ts}.db`);
const latest = path.join(BAK_DIR, 'delta-latest.db');

const db = new Database(SRC);
db.backup(dest)
  .then(() => {
    // 同时刷新一份 latest 供本地拉取
    fs.copyFileSync(dest, latest);
    // 清理 30 天前的归档
    for (const f of fs.readdirSync(BAK_DIR)) {
      if (!/^delta-\d{8}-\d{6}\.db$/.test(f)) continue;
      const fp = path.join(BAK_DIR, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > 30 * 864e5) fs.unlinkSync(fp);
    }
    db.close();
    console.log(`[backup] OK -> ${dest}`);
  })
  .catch((e) => {
    console.error('[backup] FAILED:', e);
    process.exit(1);
  });
