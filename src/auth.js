const jwt = require('jsonwebtoken');

function signUser(user) {
  return jwt.sign(
    { sub: user.id, code: user.employee_code, role: user.role, name: user.display_name },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ ok: false, message: 'Sesión inválida o expirada' });
  }
}

module.exports = { signUser, verifyToken, authMiddleware };
