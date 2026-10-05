const { getDb } = require('../database');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy();
    return res.redirect('/login');
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).send('无权访问，仅管理员可用');
    }
    next();
  });
}

function requireVerified(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === 'unverified' || req.user.role === 'rejected') {
      return res.status(403).send('您的账号尚未通过审核或被拒绝，请联系管理员');
    }
    next();
  });
}

// 打手账号可见：打手本人或管理员。打手仅能访问绑定到自己手机编号的数据。
function requireBooster(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === 'booster' || req.user.role === 'admin') {
      return next();
    }
    return res.status(403).send('无权访问，仅打手账号可用');
  });
}

module.exports = { requireAuth, requireAdmin, requireVerified, requireBooster };
