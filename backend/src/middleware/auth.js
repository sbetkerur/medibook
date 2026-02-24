const jwt = require('jsonwebtoken');
const { query } = require('../db');

async function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function tenantMiddleware(req, res, next) {
  try {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) return res.status(403).json({ error: 'No tenant associated with this token' });
    const r = await query(`SELECT * FROM tenants WHERE id=$1 AND status='active'`, [tenantId]);
    if (!r.rows[0]) return res.status(403).json({ error: 'Tenant not found or inactive' });
    req.tenant = r.rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: 'Tenant lookup failed' });
  }
}

module.exports = { authMiddleware, tenantMiddleware };
