const jwt = require('jsonwebtoken');

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 24) {
    throw new Error('JWT_SECRET must contain at least 24 characters');
  }
  return value;
}

function signUser(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, role: user.role, code: user.employee_code },
    secret(),
    { expiresIn: '7d', issuer: '417-maid-chat' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, secret(), { issuer: '417-maid-chat' });
}

function authMiddleware(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({ ok: false, message: 'Authentication required' });
  }

  try {
    req.auth = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ ok: false, message: 'Invalid or expired session' });
  }
}

module.exports = { signUser, verifyToken, authMiddleware };
