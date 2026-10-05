const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = path.join(__dirname, 'data', 'delta.db');
let db;
function getDb() {
  if (!db) { db = new Database(DB_PATH); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); initSchema(); }
  return db;
}
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,nickname TEXT DEFAULT '',role TEXT NOT NULL DEFAULT 'unverified',created_at DATETIME DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT,customer_number INTEGER NOT NULL,wechat_name TEXT DEFAULT '',login_method TEXT DEFAULT '',game_id TEXT DEFAULT '',region TEXT DEFAULT '',acceleration_location TEXT DEFAULT '',notes TEXT DEFAULT '',created_at DATETIME DEFAULT (datetime('now','localtime')),updated_at DATETIME DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS clubs (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,created_at DATETIME DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS wechat_groups (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,type TEXT DEFAULT '微信群',created_at DATETIME DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS customer_wechats (id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,wechat_name TEXT NOT NULL,type TEXT NOT NULL DEFAULT '微信群',created_at DATETIME DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS phones (id INTEGER PRIMARY KEY AUTOINCREMENT,phone_number INTEGER NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'idle',created_at DATETIME DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT,order_number TEXT,customer_id INTEGER NOT NULL REFERENCES customers(id),phone_id INTEGER REFERENCES phones(id),total_harfbux REAL DEFAULT 0,initial_cash TEXT DEFAULT '',initial_assets TEXT DEFAULT '',received_amount REAL DEFAULT 0,club_name TEXT DEFAULT '',order_wechat_name TEXT DEFAULT '',order_game_id TEXT DEFAULT '',status TEXT NOT NULL DEFAULT 'active',early_remaining_harfbux REAL DEFAULT 0,started_at DATETIME DEFAULT (datetime('now','localtime')),completed_at DATETIME,notes TEXT DEFAULT '',query_token TEXT DEFAULT '',created_at DATETIME DEFAULT (datetime('now','localtime')),updated_at DATETIME DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL REFERENCES orders(id),date TEXT NOT NULL,start_amount REAL DEFAULT 0,end_amount REAL DEFAULT 0,change_amount REAL DEFAULT 0,balance_difference REAL DEFAULT 0,notes TEXT DEFAULT '',created_at DATETIME DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL REFERENCES orders(id),date TEXT NOT NULL,amount REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'unpaid',notes TEXT DEFAULT '',created_at DATETIME DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS handler_records (id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL REFERENCES orders(id),date TEXT NOT NULL,amount REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'unpaid',notes TEXT DEFAULT '',created_at DATETIME DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS operation_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER REFERENCES users(id),username TEXT DEFAULT '',action_type TEXT NOT NULL,target_type TEXT NOT NULL,target_id INTEGER,description TEXT DEFAULT '',created_at DATETIME DEFAULT (datetime('now','localtime')));
  `);
  const orderColumns = db.prepare('PRAGMA table_info(orders)').all();
  const orderColumnNames = new Set(orderColumns.map(function(column) { return column.name; }));
  if (!orderColumnNames.has('order_number')) {
    db.exec("ALTER TABLE orders ADD COLUMN order_number TEXT DEFAULT ''");
  }
  if (!orderColumnNames.has('early_remaining_harfbux')) {
    db.exec("ALTER TABLE orders ADD COLUMN early_remaining_harfbux REAL DEFAULT 0");
  }
  if (!orderColumnNames.has('query_token')) {
    db.exec("ALTER TABLE orders ADD COLUMN query_token TEXT DEFAULT ''");
  }
  const missingTokens = db.prepare("SELECT id FROM orders WHERE query_token IS NULL OR trim(query_token)='' ").all();
  const updateToken = db.prepare('UPDATE orders SET query_token=? WHERE id=?');
  const tokenChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  missingTokens.forEach(function(order) {
    let token;
    do {
      token = '';
      for (let i = 0; i < 6; i++) token += tokenChars[Math.floor(Math.random() * tokenChars.length)];
    } while (db.prepare('SELECT 1 FROM orders WHERE query_token=?').get(token));
    updateToken.run(token, order.id);
  });
  // 自动生成手机编号 1-200（仅首次）
  const cnt = db.prepare('SELECT COUNT(*) as c FROM phones').get();
  if (cnt.c === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO phones (phone_number) VALUES (?)');
    for (let i = 1; i <= 200; i++) ins.run(i);
  }

  // 新增订单序号字段（建单时分配，替代按 created_at 动态推算）
  if (!orderColumnNames.has('order_seq')) {
    db.exec('ALTER TABLE orders ADD COLUMN order_seq INTEGER');
  }
  // 一次性回填历史订单序号（按创建时间排序）
  const seqFilled = db.prepare('SELECT COUNT(*) as c FROM orders WHERE order_seq IS NOT NULL').get();
  if (seqFilled.c === 0) {
    const allOrders = db.prepare('SELECT id FROM orders ORDER BY created_at ASC, id ASC').all();
    const seqUpd = db.prepare('UPDATE orders SET order_seq=? WHERE id=?');
    allOrders.forEach(function(o, i) { seqUpd.run(i + 1, o.id); });
  }
  // 删除冗余的 received_amount 列（展示层改用 SUM(payments) 计算）
  if (orderColumnNames.has('received_amount')) {
    db.exec('ALTER TABLE orders DROP COLUMN received_amount');
  }

  // 打手账号绑定手机编号（username=手机编号，phone_id 指向 phones）
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  const userColumnNames = new Set(userColumns.map(function(c) { return c.name; }));
  if (!userColumnNames.has('phone_id')) {
    db.exec('ALTER TABLE users ADD COLUMN phone_id INTEGER REFERENCES phones(id)');
  }

  // 交易记录录入人（多人录入追责）
  const txColumns = db.prepare('PRAGMA table_info(transactions)').all();
  const txColumnNames = new Set(txColumns.map(function(c) { return c.name; }));
  if (!txColumnNames.has('created_by')) {
    db.exec('ALTER TABLE transactions ADD COLUMN created_by INTEGER REFERENCES users(id)');
  }
  // 轮次状态：pending=已记录开始金额、待结束；completed=开始+结束齐全。存量交易默认 completed
  if (!txColumnNames.has('round_status')) {
    db.exec("ALTER TABLE transactions ADD COLUMN round_status TEXT DEFAULT 'completed'");
  }
}
function closeDb(){if(db){db.close();db=null;}}
module.exports={getDb,closeDb};
