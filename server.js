const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb, closeDb } = require('./database');
const seed = require('./seed');
const { requireAuth, requireAdmin, requireVerified, requireBooster } = require('./middleware/auth');
const QRCode = require('qrcode');

const app = express();
const PORT = 3000;

const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function createQueryToken(d) {
  let token;
  do {
    token = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) token += TOKEN_CHARS[bytes[i] % TOKEN_CHARS.length];
  } while (d.prepare('SELECT 1 FROM orders WHERE query_token=?').get(token));
  return token;
}

function createOrderNumber(d) {
  const now = new Date();
  const date = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  let orderNumber;
  do {
    orderNumber = 'DELTA-' + date + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (d.prepare('SELECT 1 FROM orders WHERE order_number=?').get(orderNumber));
  return orderNumber;
}

// 重算某订单全部交易的余额差（新增/删除交易后调用，保证余额连续）
function recomputeBalances(d, orderId) {
  const o = d.prepare('SELECT total_harfbux FROM orders WHERE id=?').get(orderId);
  // 只重算已完成的轮次（change_amount 非空）；进行中(pending)的行不参与余额推算
  const txs = d.prepare('SELECT id,change_amount FROM transactions WHERE order_id=? AND change_amount IS NOT NULL ORDER BY date ASC,id ASC').all(orderId);
  let running = o ? +o.total_harfbux : 0;
  const upd = d.prepare('UPDATE transactions SET balance_difference=? WHERE id=?');
  txs.forEach(function(t) { running = +(running - t.change_amount).toFixed(2); upd.run(running, t.id); });
}

const BACKUP_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// 零依赖 gzip：OCR 的 core（.wasm ~2.9MB、.wasm.js ~3.9MB）是未压缩下发的，手机端很慢。
// 只对 .js/.mjs/.wasm 生效，压缩结果按 mtime 缓存一次；任何异常都放行给 express.static。
// 刻意不碰 .gz：eng.traineddata.gz 由 tesseract.js 自行解压，再叠加 Content-Encoding 会重复解压出错。
const PUBLIC_DIR = path.join(__dirname, 'public');
const GZIP_EXT = /\.(js|mjs|wasm)$/i;
const GZIP_MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm'
};
const gzipCache = new Map();

function sendGzip(res, entry) {
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Content-Type', entry.mime);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Content-Length', entry.body.length);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(entry.body);
}

app.use((req, res, next) => {
  if (req.method !== 'GET' || !GZIP_EXT.test(req.path)) return next();
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
  let file;
  try {
    file = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(req.path));
  } catch (e) { return next(); }
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return next(); // 防目录穿越
  const mime = GZIP_MIME[path.extname(file).toLowerCase()];
  if (!mime) return next();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile() || st.size === 0) return next();
    const key = file + '|' + st.mtimeMs;
    const hit = gzipCache.get(key);
    if (hit) return sendGzip(res, hit);
    fs.readFile(file, (e2, buf) => {
      if (e2) return next();
      zlib.gzip(buf, { level: 6 }, (e3, gz) => {
        if (e3) return next();
        if (gzipCache.size > 64) gzipCache.clear();
        const entry = { body: gz, mime: mime };
        gzipCache.set(key, entry);
        sendGzip(res, entry);
      });
    });
  });
});

app.use(express.static(PUBLIC_DIR));
const SESSION_SECRET = process.env.SESSION_SECRET || 'delta-session-secret-2026-change-me';
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 86400000, httpOnly: true, sameSite: 'lax' } }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

seed();

// Wrapper middleware
app.use((r, s, n) => {
  const o = s.render.bind(s);
  s.render = (v, p = {}, c) => {
    if (v === 'wrapper' || v === 'order-print') return o(v, p, c);
    o(v, p, (e, h) => {
      if (e) return n(e);
      o('wrapper', { ...p, content: h }, c);
    });
  };
  n();
});

// User locale
app.use((r, s, n) => {
  s.locals.user = r.session.userId ? { id: r.session.userId, username: r.session.username, role: r.session.role } : null;
  n();
});

// 打手账号访问闸门：仅允许进入自己的派单门户，其余一律 403（防止越权看管理员数据）
app.use((r, s, n) => {
  if (r.session && r.session.role === 'booster') {
    const p = (r.path || r.url.split('?')[0]);
    if (!/^(\/booster(\/.*)?|\/profile|\/logout|\/login)$/.test(p)) {
      return s.status(403).send('打手账号无权访问该页面');
    }
  }
  n();
});

// ==================== Auth ====================
app.get('/login', (r, s) => {
  if (r.session.userId) return s.redirect('/');
  s.render('login', { title: '登录', error: null });
});

app.post('/login', (r, s) => {
  const { username, password } = r.body;
  const d = getDb();
  const u = d.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password)) return s.render('login', { title: '登录', error: '账号或密码错误' });
  r.session.userId = u.id;
  r.session.username = u.username;
  r.session.role = u.role;
  s.redirect(u.role === 'booster' ? '/booster' : '/');
});

app.get('/logout', (r, s) => { r.session.destroy(); s.redirect('/login'); });

app.get('/register', (r, s) => { s.render('register', { title: '注册', error: null }); });

app.post('/register', (r, s) => {
  const { username, password, nickname } = r.body;
  if (!username || !password) return s.render('register', { title: '注册', error: '不能为空' });
  const d = getDb();
  if (d.prepare('SELECT id FROM users WHERE username=?').get(username)) return s.render('register', { title: '注册', error: '账号已存在' });
  d.prepare('INSERT INTO users (username,password,nickname,role) VALUES (?,?,?,?)').run(username, bcrypt.hashSync(password, 10), nickname || username, 'unverified');
  s.redirect('/login');
});

// ==================== Dashboard ====================
app.get('/', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const n = new Date();
  const ms = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-01';
  const ao = d.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status=?").get('active');
  const tc = d.prepare("SELECT COUNT(*) as cnt FROM customers").get();
  const to = d.prepare("SELECT COUNT(*) as cnt FROM orders").get();
  const mr = d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE status=? AND date>=?").get('paid', ms);
  const mh = d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM handler_records WHERE status=? AND date>=?").get('paid', ms);
  const mp = +(mr.t - mh.t).toFixed(2);

  const mo = d.prepare("SELECT strftime('%Y-%m',completed_at) as month, COUNT(*) as count FROM orders WHERE status IN ('completed','early_completed') AND completed_at IS NOT NULL GROUP BY month ORDER BY month DESC").all();
  const monthlyMap = {};
  mo.forEach(function(m) {
    if (!monthlyMap[m.month]) monthlyMap[m.month] = { received: 0, handler: 0, count: m.count };
  });
  Object.keys(monthlyMap).forEach(function(k) {
    monthlyMap[k].received = d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE order_id IN (SELECT id FROM orders WHERE strftime('%Y-%m',completed_at)=?) AND status='paid'").get(k).t;
    monthlyMap[k].handler = d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM handler_records WHERE order_id IN (SELECT id FROM orders WHERE strftime('%Y-%m',completed_at)=?) AND status='paid'").get(k).t;
  });
  const monthlyStats = Object.keys(monthlyMap).sort().reverse().map(function(k) {
    return { month: k, count: monthlyMap[k].count, received: monthlyMap[k].received, handler: monthlyMap[k].handler };
  });

  s.render('dashboard', {
    title: '首页概览', activeOrders: ao, totalCustomers: tc, totalOrders: to,
    monthReceived: mr.t, monthHandler: mh.t, monthProfit: mp, monthlyStats: monthlyStats
  });
});

// ==================== Customers ====================
app.get('/customers', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  s.render('customers', {
    title: '客户管理',
    customers: d.prepare("SELECT c.*,(SELECT COUNT(*) FROM orders WHERE customer_id=c.id) as total_orders FROM customers c ORDER BY c.customer_number ASC").all()
  });
});

app.get('/customers/new', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  s.render('customer-new', {
    title: '新增客户', customer: null,
    nextNum: (d.prepare('SELECT COALESCE(MAX(customer_number),0) as n FROM customers').get()).n + 1
  });
});

app.post('/customers/new', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const b = r.body;
  const p = d.prepare('INSERT INTO customers (customer_number,wechat_name,login_method,game_id,region,acceleration_location,notes) VALUES (?,?,?,?,?,?,?)').run(
    b.customer_number, b.wechat_name, b.login_method, b.game_id, b.region, b.acceleration_location, b.notes
  );
  s.redirect('/customers');
});

app.get('/customers/:id', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const c = d.prepare('SELECT * FROM customers WHERE id=?').get(r.params.id);
  if (!c) return s.status(404).send('客户不存在');
  const orders = d.prepare("SELECT o.*,p.phone_number,(SELECT COALESCE(SUM(amount),0) FROM payments WHERE order_id=o.id AND status='paid') as received_amount FROM orders o LEFT JOIN phones p ON o.phone_id=p.id WHERE o.customer_id=? ORDER BY o.created_at DESC").all(c.id);
  s.render('customer-detail', { title: c.wechat_name, customer: c, orders: orders });
});

app.post('/customers/:id/edit', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const b = r.body;
  d.prepare("UPDATE customers SET wechat_name=?,login_method=?,game_id=?,region=?,acceleration_location=?,notes=?,updated_at=datetime('now','localtime') WHERE id=?").run(
    b.wechat_name, b.login_method, b.game_id, b.region, b.acceleration_location, b.notes, r.params.id
  );
  s.redirect('/customers/' + r.params.id);
});

app.post('/customers/:id/delete', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const customerId = r.params.id;
  
  try {
    const orders = d.prepare('SELECT id FROM orders WHERE customer_id=?').all(customerId);
    const orderIds = orders.map(o => o.id);

    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      d.prepare('UPDATE phones SET status=? WHERE id IN (SELECT phone_id FROM orders WHERE customer_id=? AND phone_id IS NOT NULL)').run('idle', customerId);
      d.prepare('DELETE FROM transactions WHERE order_id IN (' + placeholders + ')').run(...orderIds);
      d.prepare('DELETE FROM payments WHERE order_id IN (' + placeholders + ')').run(...orderIds);
      d.prepare('DELETE FROM handler_records WHERE order_id IN (' + placeholders + ')').run(...orderIds);
      d.prepare('DELETE FROM orders WHERE customer_id=?').run(customerId);
    }

    try {
      d.prepare('DELETE FROM customer_wechats WHERE customer_id=?').run(customerId);
    } catch(e) {}

    d.prepare('DELETE FROM customers WHERE id=?').run(customerId);
    s.redirect('/customers');
  } catch (error) {
    console.error('Delete customer error:', error);
    s.status(500).send('删除失败: ' + error.message);
  }
});

// ==================== WeChat management ====================
app.get('/wechats/manage', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  s.render('wechat-manage', { title: '微信群管理', groups: d.prepare("SELECT * FROM wechat_groups ORDER BY name").all() });
});

app.post('/wechats/groups/add', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const { name, type } = r.body;
  if (!name) return s.status(400).send('不能为空');
  d.prepare('INSERT INTO wechat_groups (name,type) VALUES (?,?)').run(name, type || '微信群');
  s.redirect('/wechats/manage');
});

app.post('/wechats/groups/delete', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const { name } = r.body;
  if (!name) return;
  d.prepare('DELETE FROM wechat_groups WHERE name=?').run(name);
  s.redirect('/wechats/manage');
});

// customer_wechats routes for backward compat
app.post('/wechats/:id/delete', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const w = d.prepare('SELECT * FROM customer_wechats WHERE id=?').get(r.params.id);
  if (!w) return;
  d.prepare('DELETE FROM customer_wechats WHERE id=?').run(w.id);
  s.redirect('/wechats/manage');
});

app.post('/customers/:id/wechats/new', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const b = r.body;
  d.prepare('INSERT INTO customer_wechats (customer_id,wechat_name,type) VALUES (?,?,?)').run(r.params.id, b.wechat_name, b.type || '微信群');
  s.redirect('/customers/' + r.params.id);
});

// ==================== Clubs ====================
app.get('/clubs', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  s.render('clubs', {
    title: '俱乐部管理',
    clubs: d.prepare("SELECT c.*,(SELECT COUNT(*) FROM orders WHERE club_name=c.name) as cnt FROM clubs c ORDER BY c.name").all()
  });
});

app.post('/clubs/add', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const { name } = r.body;
  if (!name) return s.status(400).send('不能为空');
  d.prepare('INSERT OR IGNORE INTO clubs (name) VALUES (?)').run(name);
  s.redirect('/clubs');
});

app.post('/clubs/delete', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const { name } = r.body;
  if (!name) return;
  d.prepare('DELETE FROM clubs WHERE name=?').run(name);
  s.redirect('/clubs');
});

// ==================== Phones ====================
app.get('/phones', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  s.render('phones', {
    title: '手机管理',
    phones: d.prepare("SELECT p.*,o.id as oid,o.status as ost,c.customer_number,c.wechat_name FROM phones p LEFT JOIN orders o ON p.id=o.phone_id AND o.status='active' LEFT JOIN customers c ON o.customer_id=c.id ORDER BY p.phone_number ASC").all()
  });
});

app.post('/phones/new', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const { phone_number } = r.body;
  if (!phone_number) return s.status(400).send('手机号不能为空');
  try {
    d.prepare('INSERT INTO phones (phone_number) VALUES (?)').run(parseInt(phone_number));
  } catch(e) {
    return s.status(400).send('新手机号已存在');
  }
  s.redirect('/phones');
});

app.post('/phones/:id/status', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const phone = d.prepare('SELECT * FROM phones WHERE id=?').get(r.params.id);
  if (!phone) return s.status(404).send('手机不存在');
  const status = r.body.status;
  if (!['idle', 'in_use', 'maintenance'].includes(status)) return s.status(400).send('状态无效');

  const inUseOrder = d.prepare("SELECT id FROM orders WHERE phone_id=? AND status='active' LIMIT 1").get(phone.id);
  if (status === 'idle' && inUseOrder) return s.status(400).send('该手机仍被进行中的订单占用，不能置为空闲');

  d.prepare('UPDATE phones SET status=? WHERE id=?').run(status, phone.id);
  s.redirect('/phones');
});

app.post('/phones/:id/delete', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const phone = d.prepare('SELECT * FROM phones WHERE id=?').get(r.params.id);
  if (!phone) return s.status(404).send('手机不存在');

  const inUseOrder = d.prepare("SELECT id FROM orders WHERE phone_id=? AND status='active' LIMIT 1").get(phone.id);
  if (inUseOrder) return s.status(400).send('该手机仍被进行中的订单占用，不能删除');

  d.prepare('UPDATE orders SET phone_id=NULL WHERE phone_id=?').run(phone.id);
  d.prepare('DELETE FROM phones WHERE id=?').run(phone.id);
  s.redirect('/phones');
});

// ==================== Public Tracking ====================
app.get('/public/track', (r, s) => {
  const orderNumber = String(r.query.order_number || '').trim();
  const queryToken = String(r.query.query_token || '').trim().toUpperCase();
  if (orderNumber && queryToken) {
    const d = getDb();
    const o = d.prepare("SELECT o.*, c.wechat_name, p.phone_number FROM orders o JOIN customers c ON o.customer_id=c.id LEFT JOIN phones p ON o.phone_id=p.id WHERE o.order_number=? AND o.query_token=?").get(orderNumber, queryToken);
    if (o) {
      const tx = d.prepare("SELECT t.* FROM transactions t WHERE t.order_id=? ORDER BY t.date ASC").all(o.id);
      const pm = d.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY date ASC').all(o.id);
      const hr = d.prepare('SELECT * FROM handler_records WHERE order_id=? ORDER BY date ASC').all(o.id);
      return s.render('public/order-status', { title: '订单进度: ' + o.order_number, order: o, transactions: tx, payments: pm, handlerRecords: hr });
    }
    return s.render('public/track', { title: '订单进度查询', error: '查询失败，请检查订单号和验证码是否正确' });
  }
  s.render('public/track', { title: '订单进度查询' });
});

// 客户查询二维码：订单号+验证码 → 编码「直接深链」的 PNG，可发给客户扫码
app.get('/public/qrcode', (r, s) => {
  const orderNumber = String(r.query.order_number || '').trim();
  const queryToken = String(r.query.query_token || '').trim().toUpperCase();
  if (!orderNumber || !queryToken) return s.status(400).send('缺少订单号或验证码');
  const d = getDb();
  const o = d.prepare('SELECT id,order_number,query_token FROM orders WHERE order_number=? AND query_token=?').get(orderNumber, queryToken);
  if (!o) return s.status(403).send('验证码无效');
  const proto = r.get('x-forwarded-proto') || r.protocol;
  const base = proto + '://' + r.get('host');
  const url = base + '/public/track?order_number=' + encodeURIComponent(o.order_number) + '&query_token=' + o.query_token;
  QRCode.toBuffer(url, { type: 'png', width: 320, margin: 1, errorCorrectionLevel: 'M' }, function(err, buf) {
    if (err) return s.status(500).send('二维码生成失败');
    s.set('Content-Type', 'image/png');
    s.send(buf);
  });
});

app.post('/public/track', (r, s) => {
  const orderNumber = String(r.body.order_number || '').trim();
  const queryToken = String(r.body.query_token || '').trim().toUpperCase();
  const d = getDb();
  const o = d.prepare("SELECT o.*, c.wechat_name, p.phone_number FROM orders o JOIN customers c ON o.customer_id=c.id LEFT JOIN phones p ON o.phone_id=p.id WHERE o.order_number=? AND o.query_token=?").get(orderNumber, queryToken);
  
  if (!o) return s.render('public/track', { title: '订单进度查询', error: '查询失败，请检查订单号和验证码是否正确' });

  const tx = d.prepare("SELECT t.* FROM transactions t WHERE t.order_id=? ORDER BY t.date ASC").all(o.id);
  const pm = d.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY date ASC').all(o.id);
  const hr = d.prepare('SELECT * FROM handler_records WHERE order_id=? ORDER BY date ASC').all(o.id);
  
  s.render('public/order-status', {
    title: '订单进度: ' + o.order_number,
    order: o,
    transactions: tx,
    payments: pm,
    handlerRecords: hr
  });
});

// 客户凭验证码打印派单记录（含交易记录），无需后台登录
app.get('/public/orders/:id/print', (r, s) => {
  const d = getDb();
  const token = String(r.query.token || '').trim().toUpperCase();
  const o = d.prepare("SELECT o.*,c.wechat_name,c.login_method,c.game_id,c.region,c.acceleration_location,p.phone_number FROM orders o JOIN customers c ON o.customer_id=c.id LEFT JOIN phones p ON o.phone_id=p.id WHERE o.id=? AND o.query_token=?").get(r.params.id, token);
  if (!o) return s.status(403).send('验证码无效或无权限查看该派单');
  const tx = d.prepare("SELECT t.* FROM transactions t WHERE t.order_id=? ORDER BY t.date ASC, t.id ASC").all(o.id);
  s.render('order-print', { order: Object.assign({}, o, { sequence: o.order_seq || 0 }), transactions: tx });
});

// ==================== Orders list ====================
app.get('/orders/active', requireAuth, requireVerified, (r, s) => {
    const d = getDb();
  const selectedClub = r.query.club || '';
  const clubCond = selectedClub ? ' AND o.club_name=?' : '';
  const orders = d.prepare("SELECT o.*,c.customer_number,c.wechat_name,c.login_method,c.game_id,p.phone_number FROM orders o JOIN customers c ON o.customer_id=c.id LEFT JOIN phones p ON o.phone_id=p.id WHERE o.status='active'" + clubCond + " ORDER BY o.created_at ASC").all(selectedClub ? [selectedClub] : []);
    const result = orders.map(function(o) {
      const paidTotal = d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE order_id=? AND status=?").get(o.id, "paid").t;
      return Object.assign({}, o, { received_amount: paidTotal, sequence: o.order_seq });
    });
    const clubs = d.prepare("SELECT DISTINCT club_name FROM orders WHERE club_name IS NOT NULL AND club_name!='' AND status='active' ORDER BY club_name").all();
    s.render('orders-active', { title: '进行中订单', orders: result, clubs: clubs.map(c => c.club_name), selectedClub: selectedClub });
  });

app.get('/orders/completed', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const selectedClub = r.query.club || '';
  const clubCond = selectedClub ? "AND o.club_name=?" : "";
  const orders = d.prepare("SELECT o.*,c.customer_number,c.wechat_name,c.login_method,p.phone_number FROM orders o JOIN customers c ON o.customer_id=c.id LEFT JOIN phones p ON o.phone_id=p.id WHERE o.status IN ('completed','early_completed') " + clubCond + " ORDER BY o.completed_at DESC").all(selectedClub ? [selectedClub] : []);
  const result = orders.map(function(o) {
      const paidTotal = d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE order_id=? AND status=?").get(o.id, "paid").t;
      const handlerTotal = d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM handler_records WHERE order_id=? AND status=?").get(o.id, "paid").t;
    return Object.assign({}, o, { received_amount: paidTotal, handler_amount: handlerTotal, sequence: o.order_seq });
  });
  const clubs = d.prepare("SELECT DISTINCT club_name FROM orders WHERE club_name IS NOT NULL AND club_name!='' ORDER BY club_name").all();
  s.render('orders-completed', { title: '已结单列表', orders: result, clubs: clubs.map(c => c.club_name), selectedClub: selectedClub });
});

app.get('/orders/generate-number', requireAuth, requireVerified, (r, s) => {
  s.json({ order_number: createOrderNumber(getDb()) });
});

// ==================== New order ====================
app.get('/orders/new', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const customers = d.prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
  const phones = d.prepare("SELECT * FROM phones WHERE status='idle' ORDER BY phone_number ASC").all();
  const clubs = d.prepare('SELECT name FROM clubs ORDER BY name').all();
  const wechatGroups = d.prepare('SELECT * FROM wechat_groups ORDER BY name').all();
  let customerHistoryPhones = {};
  customers.forEach(function(c) {
    var histAll = d.prepare("SELECT p.phone_number,p.id as phone_id,o.id as order_id,o.completed_at FROM orders o JOIN phones p ON o.phone_id=p.id WHERE o.customer_id=? AND o.status IN ('completed','early_completed') AND o.phone_id IS NOT NULL ORDER BY o.completed_at DESC").all(c.id);
    if (histAll.length > 0) customerHistoryPhones[c.id] = histAll;
  });
  s.render('order-new', { title: '新建订单', customers, phones, clubs, wechatGroups, order: null, earlyHint: null, customerHistoryPhones});
});

app.post('/orders/new', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const b = r.body;
  const customer = d.prepare('SELECT id FROM customers WHERE id=?').get(b.customer_id);
  if (!customer) return s.status(400).send('客户不存在');
  const phone = b.phone_id ? d.prepare('SELECT * FROM phones WHERE id=?').get(b.phone_id) : null;
  if (b.phone_id && (!phone || phone.status !== 'idle')) return s.status(400).send('该手机不存在或正在使用中');
  const orderNumber = (b.order_number || '').trim() || createOrderNumber(d);
  if (d.prepare('SELECT id FROM orders WHERE order_number=?').get(orderNumber)) return s.status(400).send('订单编号已存在，请更换后再试');
  const createOrder = d.transaction(function() {
    const queryToken = createQueryToken(d);
    const p = d.prepare('INSERT INTO orders (order_number,customer_id,phone_id,total_harfbux,initial_cash,initial_assets,club_name,order_wechat_name,order_game_id,notes,query_token) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      orderNumber, b.customer_id, b.phone_id || null, b.total_harfbux || 0,
      b.initial_cash || '', b.initial_assets || '', b.club_name || '',
      b.order_wechat_name || '', b.order_game_id || '', b.notes || '', queryToken
    );
    if (phone) d.prepare('UPDATE phones SET status=? WHERE id=?').run('in_use', phone.id);
    return p.lastInsertRowid;
  });
  const orderId = createOrder();
  recomputeBalances(d, orderId);
  s.redirect('/orders/' + orderId);
});

app.get('/orders/:id', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const o = d.prepare("SELECT o.*,c.customer_number,c.wechat_name,c.login_method,c.game_id,c.region,c.acceleration_location,p.phone_number FROM orders o JOIN customers c ON o.customer_id=c.id LEFT JOIN phones p ON o.phone_id=p.id WHERE o.id=?").get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  const tx = d.prepare("SELECT t.* FROM transactions t WHERE t.order_id=? ORDER BY t.date ASC").all(o.id);
  const pm = d.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY date ASC').all(o.id);
  const hr = d.prepare('SELECT * FROM handler_records WHERE order_id=? ORDER BY date ASC').all(o.id);
  const receivedTotal = pm.reduce(function(s, p) { return s + (p.status === 'paid' ? p.amount : 0); }, 0);
  const handlerTotal = hr.reduce(function(s, h) { return s + (h.status === 'paid' ? h.amount : 0); }, 0);
  const cs = d.prepare('SELECT * FROM customers ORDER BY customer_number ASC').all();
  const ps = d.prepare("SELECT * FROM phones WHERE status='idle' OR id=? ORDER BY phone_number ASC").all(o.phone_id);
  const cs2 = d.prepare('SELECT name FROM clubs ORDER BY name').all();
  const wgs = d.prepare('SELECT * FROM wechat_groups ORDER BY name').all();
  let eh = null;
  if (o.status === 'active') {
    const dd = d.prepare('SELECT COALESCE(SUM(change_amount),0) as d FROM transactions WHERE order_id=?').get(o.id);
    const r2 = o.total_harfbux - dd.d;
    if (r2 > 0) eh = { remaining: r2.toFixed(2) };
  }
  let prevPhones = {};
  if (cs.length > 0) {
    cs.forEach(function(c) {
      var hist = d.prepare(`SELECT p.phone_number,o.completed_at FROM orders o JOIN phones p ON o.phone_id=p.id WHERE o.customer_id=? AND o.status IN ('completed','early_completed') AND o.phone_id IS NOT NULL ORDER BY o.completed_at DESC LIMIT 1`).get(c.id);
      if (hist) prevPhones[c.id] = hist;
    });
  }
  s.render('order-detail', {
    title: '订单#' + o.id + ' ' + o.wechat_name, order: o, transactions: tx, payments: pm, handlerRecords: hr,
    receivedTotal, handlerTotal, customers: cs, phones: ps, clubs: cs2, wechatGroups: wgs, earlyHint: eh, prevPhones
  });
});

app.post('/orders/:id/edit', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const o = d.prepare('SELECT * FROM orders WHERE id=?').get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  const b = r.body;
  const customer = d.prepare('SELECT id FROM customers WHERE id=?').get(b.customer_id);
  if (!customer) return s.status(400).send('客户不存在');
  const phoneId = b.phone_id || null;
  const phone = phoneId ? d.prepare('SELECT * FROM phones WHERE id=?').get(phoneId) : null;
  if (phoneId && !phone) return s.status(400).send('手机不存在');
  if (phoneId && phoneId != o.phone_id && phone.status !== 'idle') return s.status(400).send('该手机正在使用中');
  const updateOrder = d.transaction(function() {
    if (o.phone_id && o.phone_id != phoneId) d.prepare('UPDATE phones SET status=? WHERE id=?').run('idle', o.phone_id);
    if (phoneId) d.prepare('UPDATE phones SET status=? WHERE id=?').run('in_use', phoneId);
    d.prepare("UPDATE orders SET order_number=?,customer_id=?,phone_id=?,total_harfbux=?,initial_cash=?,initial_assets=?,club_name=?,order_wechat_name=?,order_game_id=?,notes=?,updated_at=datetime('now','localtime') WHERE id=?").run(
      b.order_number === undefined ? (o.order_number || '') : b.order_number.trim(), b.customer_id, phoneId, b.total_harfbux || 0, b.initial_cash || '', b.initial_assets || '', b.club_name || '', b.order_wechat_name || '', b.order_game_id || '', b.notes || '', o.id
    );
  });
  updateOrder();
  s.redirect('/orders/' + o.id);
});

// ==================== Print ====================
app.get('/orders/:id/print', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const o = d.prepare("SELECT o.*,c.customer_number,c.wechat_name,c.login_method,c.game_id,c.region,c.acceleration_location,p.phone_number FROM orders o JOIN customers c ON o.customer_id=c.id LEFT JOIN phones p ON o.phone_id=p.id WHERE o.id=?").get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  const tx = d.prepare("SELECT t.* FROM transactions t WHERE t.order_id=? ORDER BY t.date ASC, t.id ASC").all(o.id);
  s.render('order-print', { order: Object.assign({}, o, { sequence: o.order_seq || 0 }), transactions: tx });
});

// ==================== Transactions ====================
app.post('/orders/:id/transactions/new', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const o = d.prepare('SELECT * FROM orders WHERE id=?').get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  if (r.user.role === 'booster' && o.phone_id !== r.user.phone_id) return s.status(403).send('只能操作分配给自己的订单');
  const b = r.body;
  const sa = parseFloat(b.start_amount) || 0;
  const ea = parseFloat(b.end_amount) || 0;
  const ch = +(ea - sa).toFixed(2);
  const lb = d.prepare('SELECT balance_difference FROM transactions WHERE order_id=? ORDER BY date DESC LIMIT 1').get(o.id);
  const nb = +((lb ? lb.balance_difference : o.total_harfbux) - ch).toFixed(2);
  d.prepare('INSERT INTO transactions (order_id,date,start_amount,end_amount,change_amount,balance_difference,notes,created_by) VALUES (?,?,?,?,?,?,?,?)').run(o.id, b.date, sa, ea, ch, nb, b.notes || '', r.user.id);
  s.redirect('/orders/' + o.id);
});

app.post('/transactions/:id/delete', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const tx = d.prepare('SELECT * FROM transactions WHERE id=?').get(r.params.id);
  if (!tx) return s.status(404).send('交易不存在');
  d.prepare('DELETE FROM transactions WHERE id=?').run(tx.id);
  recomputeBalances(d, tx.order_id);
  s.redirect('/orders/' + tx.order_id);
});

// ==================== Payments ====================
app.post('/orders/:id/payments/new', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const o = d.prepare('SELECT * FROM orders WHERE id=?').get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  const b = r.body;
  d.prepare('INSERT INTO payments (order_id,date,amount,status,notes) VALUES (?,?,?,?,?)').run(o.id, b.date, parseFloat(b.amount) || 0, b.status || 'unpaid', b.notes || '');
  s.redirect('/orders/' + o.id);
});

app.post('/payments/:id/status', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const pm = d.prepare('SELECT * FROM payments WHERE id=?').get(r.params.id);
  if (!pm) return s.status(404).send('付款不存在');
  d.prepare('UPDATE payments SET status=? WHERE id=?').run(r.body.status, pm.id);
  s.redirect('/orders/' + pm.order_id);
});

app.post('/payments/:id/delete', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const pm = d.prepare('SELECT * FROM payments WHERE id=?').get(r.params.id);
  if (!pm) return s.status(404).send('付款不存在');
  d.prepare('DELETE FROM payments WHERE id=?').run(pm.id);
  s.redirect('/orders/' + pm.order_id);
});

// ==================== Handler Records ====================
app.post('/orders/:id/handlers/new', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const o = d.prepare('SELECT * FROM orders WHERE id=?').get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  const b = r.body;
  d.prepare('INSERT INTO handler_records (order_id,date,amount,status,notes) VALUES (?,?,?,?,?)').run(o.id, b.date, parseFloat(b.amount) || 0, b.status || 'unpaid', b.notes || '');
  s.redirect('/orders/' + o.id);
});

app.post('/handlers/:id/status', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const hr = d.prepare('SELECT * FROM handler_records WHERE id=?').get(r.params.id);
  if (!hr) return s.status(404).send('记录不存在');
  d.prepare('UPDATE handler_records SET status=? WHERE id=?').run(r.body.status, hr.id);
  s.redirect('/orders/' + hr.order_id);
});

app.post('/handlers/:id/delete', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const hr = d.prepare('SELECT * FROM handler_records WHERE id=?').get(r.params.id);
  if (!hr) return s.status(404).send('记录不存在');
  d.prepare('DELETE FROM handler_records WHERE id=?').run(hr.id);
  s.redirect('/orders/' + hr.order_id);
});

// ==================== Complete ====================
app.post('/orders/:id/complete', requireAuth, requireVerified, (r, s) => {
  const d = getDb();
  const o = d.prepare('SELECT * FROM orders WHERE id=?').get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  const er = parseFloat(r.body.early_remaining_harfbux) || 0;
  if (er > 0) {
    d.prepare("UPDATE orders SET status='early_completed',early_remaining_harfbux=?,completed_at=datetime('now','localtime') WHERE id=?").run(er, o.id);
  } else {
    d.prepare("UPDATE orders SET status='completed',completed_at=datetime('now','localtime') WHERE id=?").run(o.id);
  }
  if (o.phone_id) d.prepare('UPDATE phones SET status=? WHERE id=?').run('idle', o.phone_id);
  s.redirect('/orders/' + o.id);
});

app.post('/orders/:id/reactivate', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const o = d.prepare('SELECT * FROM orders WHERE id=?').get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  if (o.phone_id) {
    const occupied = d.prepare("SELECT id FROM orders WHERE phone_id=? AND status='active' AND id<>?").get(o.phone_id, o.id);
    if (occupied) return s.status(400).send('该手机已被其他进行中订单占用');
  }
  const reactivateOrder = d.transaction(function() {
    d.prepare("UPDATE orders SET status='active',completed_at=NULL,updated_at=datetime('now','localtime') WHERE id=?").run(o.id);
    if (o.phone_id) d.prepare('UPDATE phones SET status=? WHERE id=?').run('in_use', o.phone_id);
  });
  reactivateOrder();
  s.redirect('/orders/' + r.params.id);
});

app.post('/orders/:id/delete', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const o = d.prepare('SELECT * FROM orders WHERE id=?').get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  d.prepare('DELETE FROM transactions WHERE order_id=?').run(o.id);
  d.prepare('DELETE FROM payments WHERE order_id=?').run(o.id);
  d.prepare('DELETE FROM handler_records WHERE order_id=?').run(o.id);
  if (o.phone_id) d.prepare('UPDATE phones SET status=? WHERE id=?').run('idle', o.phone_id);
  d.prepare('DELETE FROM orders WHERE id=?').run(o.id);
  s.redirect('/orders/completed');
});

// ==================== User review ====================
app.get('/users/review', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const unverified = d.prepare("SELECT * FROM users WHERE role='unverified' ORDER BY created_at DESC").all();
  const verified = d.prepare("SELECT * FROM users WHERE role!='unverified' ORDER BY created_at DESC").all();
  s.render('user-review', { title: '用户审核', unverified, verified });
});

app.post('/users/:id/approve', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  d.prepare("UPDATE users SET role='user' WHERE id=?").run(r.params.id);
  s.redirect('/users/review');
});

app.post('/users/:id/verify', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  d.prepare("UPDATE users SET role='user' WHERE id=?").run(r.params.id);
  s.redirect('/users/review');
});

app.post('/users/:id/reject', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  d.prepare("UPDATE users SET role='rejected' WHERE id=?").run(r.params.id);
  s.redirect('/users/review');
});

app.post('/users/:id/delete', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  d.prepare('DELETE FROM users WHERE id=?').run(r.params.id);
  s.redirect('/users/review');
});

// ==================== 打手账号管理（管理员） ====================
app.get('/admin/boosters', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const phones = d.prepare("SELECT p.*,(SELECT username FROM users WHERE phone_id=p.id) as booster_username,(SELECT role FROM users WHERE phone_id=p.id) as booster_role FROM phones p ORDER BY p.phone_number ASC").all();
  s.render('admin-boosters', { title: '打手账号管理', phones: phones, msg: r.query.msg || null });
});

// 密码规则：手机编号 n -> "dfdj" + n（dfdj1 ... dfdj200）
function boosterPasswordFor(phoneNumber) { return 'dfdj' + phoneNumber; }

// 一键开通全部手机编号：仅新建「尚未有账号」的，已存在的账号保持原样不动
app.post('/admin/boosters/open-all', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const phones = d.prepare('SELECT id,phone_number FROM phones ORDER BY phone_number ASC').all();
  const ins = d.prepare('INSERT INTO users (username,password,nickname,role,phone_id) VALUES (?,?,?,?,?)');
  let created = 0;
  phones.forEach(function(p) {
    const uname = String(p.phone_number);
    if (d.prepare('SELECT id FROM users WHERE username=?').get(uname)) return; // 已存在则保持原样
    ins.run(uname, bcrypt.hashSync(boosterPasswordFor(p.phone_number), 10), '打手' + uname + '号', 'booster', p.id);
    created++;
  });
  s.redirect('/admin/boosters?msg=' + encodeURIComponent('已开通全部：本次新建 ' + created + ' 个打手账号（密码为 dfdj+编号，已存在的账号未改动）'));
});

app.post('/admin/boosters/create', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const phoneIds = Array.isArray(r.body.phone_id) ? r.body.phone_id : (r.body.phone_id ? [r.body.phone_id] : []);
  const ins = d.prepare('INSERT INTO users (username,password,nickname,role,phone_id) VALUES (?,?,?,?,?)');
  let created = 0, reopened = 0;
  phoneIds.forEach(function(pid) {
    const ph = d.prepare('SELECT phone_number FROM phones WHERE id=?').get(pid);
    if (!ph) return;
    const uname = String(ph.phone_number);
    const exists = d.prepare('SELECT id,role FROM users WHERE username=?').get(uname);
    if (exists) {
      if (exists.role !== 'booster') { d.prepare("UPDATE users SET role='booster',phone_id=? WHERE id=?").run(pid, exists.id); reopened++; }
      return; // 已存在账号保持原样：不改密码、不改用户名
    }
    ins.run(uname, bcrypt.hashSync(boosterPasswordFor(ph.phone_number), 10), '打手' + uname + '号', 'booster', pid);
    created++;
  });
  s.redirect('/admin/boosters?msg=' + encodeURIComponent('本次新建 ' + created + ' 个、恢复启用 ' + reopened + ' 个（新建密码 dfdj+编号，已存在的账号密码未改动）'));
});

app.post('/admin/boosters/:id/reset', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const u = d.prepare('SELECT * FROM users WHERE id=?').get(r.params.id);
  if (!u) return s.status(404).send('账号不存在');
  const np = r.body.password || '123456';
  d.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(np, 10), u.id);
  s.redirect('/admin/boosters');
});

app.post('/admin/boosters/:id/disable', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const u = d.prepare('SELECT * FROM users WHERE id=?').get(r.params.id);
  if (!u) return s.status(404).send('账号不存在');
  d.prepare("UPDATE users SET role='rejected',phone_id=NULL WHERE id=?").run(u.id);
  s.redirect('/admin/boosters');
});

// ==================== 打手门户 ====================
app.get('/booster', requireBooster, (r, s) => {
  const d = getDb();
  let orders;
  if (r.user.role === 'admin') {
    orders = d.prepare("SELECT o.*,c.wechat_name FROM orders o JOIN customers c ON o.customer_id=c.id WHERE o.status='active' ORDER BY o.created_at ASC").all();
  } else {
    orders = d.prepare("SELECT o.*,c.wechat_name FROM orders o JOIN customers c ON o.customer_id=c.id WHERE o.phone_id=? AND o.status='active' ORDER BY o.created_at ASC").all(r.user.phone_id);
  }
  s.render('booster-dashboard', { title: '我的派单', orders: orders, isAdmin: r.user.role === 'admin' });
});

app.get('/booster/orders/:id', requireBooster, (r, s) => {
  const d = getDb();
  const o = d.prepare("SELECT o.*,c.wechat_name,c.game_id FROM orders o JOIN customers c ON o.customer_id=c.id WHERE o.id=?").get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  if (r.user.role !== 'admin' && o.phone_id !== r.user.phone_id) return s.status(403).send('只能查看分配给自己的订单');
  const tx = d.prepare('SELECT t.*,u.username as creator FROM transactions t LEFT JOIN users u ON t.created_by=u.id WHERE t.order_id=? ORDER BY t.date ASC, t.id ASC').all(o.id);
  const pending = d.prepare("SELECT * FROM transactions WHERE order_id=? AND round_status='pending' ORDER BY id DESC LIMIT 1").get(o.id) || null;
  const lastCompleted = d.prepare("SELECT balance_difference FROM transactions WHERE order_id=? AND round_status='completed' ORDER BY date DESC, id DESC LIMIT 1").get(o.id);
  const remaining = lastCompleted ? lastCompleted.balance_difference : o.total_harfbux;
  s.render('booster-order', { title: '订单#' + o.id, order: o, transactions: tx, pending: pending, remaining: remaining });
});

// 打手分轮记账：先记开始金额（可独立保存），再记结束金额完成本轮；未完成本轮不能开下一轮
app.post('/booster/orders/:id/transactions/start', requireBooster, (r, s) => {
  const d = getDb();
  const o = d.prepare('SELECT * FROM orders WHERE id=?').get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  if (r.user.role !== 'admin' && o.phone_id !== r.user.phone_id) return s.status(403).send('只能操作分配给自己的订单');
  if (o.status !== 'active') return s.status(400).send('订单已结单，无法新增交易');
  // 未完成一轮不能开下一轮
  const pend = d.prepare("SELECT id FROM transactions WHERE order_id=? AND round_status='pending'").get(o.id);
  if (pend) return s.status(409).send('当前轮次尚未完成（已记录开始金额，待上传结束截图），请先完成本轮再记下一笔');
  const b = r.body;
  const sa = parseFloat(b.start_amount) || 0;
  const date = (b.date && b.date.trim()) || new Date().toISOString().slice(0, 10);
  d.prepare('INSERT INTO transactions (order_id,date,start_amount,end_amount,change_amount,balance_difference,notes,created_by,round_status) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(o.id, date, sa, null, null, null, b.notes || '', r.user.id, 'pending');
  s.redirect('/booster/orders/' + o.id);
});

app.post('/booster/orders/:id/transactions/end', requireBooster, (r, s) => {
  const d = getDb();
  const o = d.prepare('SELECT * FROM orders WHERE id=?').get(r.params.id);
  if (!o) return s.status(404).send('订单不存在');
  if (r.user.role !== 'admin' && o.phone_id !== r.user.phone_id) return s.status(403).send('只能操作分配给自己的订单');
  if (o.status !== 'active') return s.status(400).send('订单已结单，无法新增交易');
  const pend = d.prepare("SELECT * FROM transactions WHERE order_id=? AND round_status='pending' ORDER BY id DESC LIMIT 1").get(o.id);
  if (!pend) return s.status(409).send('没有进行中的轮次，请先记录开始金额');
  const b = r.body;
  const sa = +pend.start_amount;
  const ea = parseFloat(b.end_amount) || 0;
  const ch = +(ea - sa).toFixed(2);
  // 结束截图可填备注，与原开始备注合并
  const notes = (pend.notes ? pend.notes + (b.notes ? ' / ' + b.notes : '') : (b.notes || '')) || '';
  d.prepare('UPDATE transactions SET end_amount=?, change_amount=?, date=?, notes=?, round_status=? WHERE id=?')
    .run(ea, ch, (b.date && b.date.trim()) || pend.date, notes, 'completed', pend.id);
  recomputeBalances(d, o.id); // 完成后重算该订单余额，保证其余轮次连续
  s.redirect('/booster/orders/' + o.id);
});

// ==================== Profile ====================
app.get('/profile', requireAuth, (r, s) => { s.render('profile', { title: '个人信息', user: r.user, error: null }); });

app.post('/profile', requireAuth, (r, s) => {
  const d = getDb();
  const b = r.body;
  const u = r.user;
  if (b.nickname) d.prepare('UPDATE users SET nickname=? WHERE id=?').run(b.nickname, r.session.userId);
  if (b.old_password && b.new_password) {
    if (!bcrypt.compareSync(b.old_password, u.password)) return s.render('profile', { title: '个人信息', user: u, error: '原密码错误' });
    d.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(b.new_password, 10), r.session.userId);
  }
  r.session.username = b.nickname || r.session.username;
  s.redirect('/profile');
});

// ==================== Statistics ====================
app.get('/stats', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  const selectedMonth = r.query.month || null;
  const monthCond = selectedMonth ? "AND strftime('%Y-%m',o.completed_at)=?" : "";
  const co = d.prepare("SELECT o.*,c.customer_number,c.wechat_name,c.login_method,p.phone_number FROM orders o JOIN customers c ON o.customer_id=c.id LEFT JOIN phones p ON o.phone_id=p.id WHERE o.status IN ('completed','early_completed') AND (SELECT COUNT(*) FROM payments WHERE order_id=o.id)>0" + monthCond + " ORDER BY o.completed_at DESC"
  ).all(selectedMonth ? [selectedMonth] : []);

  const completedOrders = co.map(function(o) {
      const paidTotal = d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE order_id=? AND status=?").get(o.id, "paid").t;
      const handlerTotal = d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM handler_records WHERE order_id=? AND status=?").get(o.id, "paid").t;
    return Object.assign({}, o, { received_amount: paidTotal, handler_amount: handlerTotal });
  });

  const availableMonths = d.prepare("SELECT DISTINCT strftime('%Y-%m',completed_at) as month FROM orders WHERE status IN ('completed','early_completed') AND completed_at IS NOT NULL ORDER BY month DESC").all();

  const monthlyStats = availableMonths.map(function(m) {
    const orderIds = d.prepare("SELECT id FROM orders WHERE strftime('%Y-%m',completed_at)=? AND status IN ('completed','early_completed')").all(m.month).map(function(x) { return x.id; });
    const received = orderIds.length > 0 ? d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE order_id IN (" + orderIds.map(() => '?').join(',') + ") AND status='paid'").all(...orderIds).reduce(function(s, x) { return s + x.t; }, 0) : 0;
    const handler = orderIds.length > 0 ? d.prepare("SELECT COALESCE(SUM(amount),0) as t FROM handler_records WHERE order_id IN (" + orderIds.map(() => '?').join(',') + ") AND status='paid'").all(...orderIds).reduce(function(s, x) { return s + x.t; }, 0) : 0;
    const count = d.prepare("SELECT COUNT(*) as cnt FROM orders WHERE strftime('%Y-%m',completed_at)=? AND status IN ('completed','early_completed')").get([m.month]).cnt;
    return { month: m.month, count, received, handler };
  });

  s.render('stats', { title: '统计', completedOrders, availableMonths, monthlyStats, selectedMonth });
});

// ==================== Backup ====================
app.get('/backup', requireAuth, requireAdmin, (r, s) => {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).map(f => {
    const st = fs.statSync(path.join(BACKUP_DIR, f));
    return { name: f, size: st.size, date: st.mtime.toLocaleString('zh-CN') };
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
  s.render('backup', { title: '备份管理', backups: files });
});

app.post('/backup/create', requireAuth, requireAdmin, (r, s) => {
  const d = getDb();
  d.pragma('wal_checkpoint(TRUNCATE)');
  closeDb();
  const ts = new Date();
  const fn = 'delta-' + ts.getFullYear() + String(ts.getMonth() + 1).padStart(2, '0') + String(ts.getDate()).padStart(2, '0') + '-' + String(ts.getHours()).padStart(2, '0') + String(ts.getMinutes()).padStart(2, '0') + String(ts.getSeconds()).padStart(2, '0') + '.db';
  fs.copyFileSync(path.join(__dirname, 'data', 'delta.db'), path.join(BACKUP_DIR, fn));
  getDb();
  s.redirect('/backup');
});

app.post('/backup/download', requireAuth, requireAdmin, (r, s) => {
  const fp = path.join(BACKUP_DIR, r.body.name);
  if (!fs.existsSync(fp)) return s.status(404).send('备份文件不存在');
  s.download(fp);
});

app.post('/backup/restore', requireAuth, requireAdmin, (r, s) => {
  const { name } = r.body;
  if (!name) return s.status(400).send('参数错误');
  const fp = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(fp)) return s.status(400).send('备份文件不存在');
  closeDb();
  fs.copyFileSync(fp, path.join(__dirname, 'data', 'delta.db'));
  getDb();
  s.redirect('/backup');
});

app.post('/backup/delete', requireAuth, requireAdmin, (r, s) => {
  const { name } = r.body;
  if (!name) return s.status(400).send('参数错误');
  const fp = path.join(BACKUP_DIR, name);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  s.redirect('/backup');
});

// ==================== 404 / 500 ====================
app.use((r, s) => {
  s.status(404).render('error', { title: '页面不存在', message: '您访问的页面不存在（404）' });
});
app.use((err, r, s, n) => {
  console.error('服务器错误:', err);
  s.status(500).render('error', { title: '服务器错误', message: '服务器内部发生错误（500），请稍后重试' });
});

process.on('uncaughtException', (e) => { console.error('未捕获异常:', e); });
process.on('unhandledRejection', (e) => { console.error('未处理的 Promise 拒绝:', e); });

app.listen(PORT, () => { console.log('三角洲记账系统已启动！http://localhost:' + PORT); });
process.on('SIGINT', () => { closeDb(); process.exit(); });
process.on('SIGTERM', () => { closeDb(); process.exit(); });














