const bcrypt = require('bcryptjs');
const { getDb, closeDb } = require('./database');

function seed() {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE role = ?').get('admin');
  if (existing.cnt > 0) {
    console.log('管理员账号已存在，跳过初始化');
    return;
  }
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.log('未配置 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量，跳过管理员初始化');
    return;
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password, nickname, role) VALUES (?, ?, ?, ?)')
    .run(username, hash, username, 'admin');
  console.log(`已创建管理员: ${username}`);
}

// 直接运行时执行
if (require.main === module) {
  seed();
  closeDb();
  console.log('完成');
}

module.exports = seed;
