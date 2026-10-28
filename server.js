const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const db = new Database(path.join(__dirname, 'store.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL,
  notes TEXT, price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, image TEXT DEFAULT '/images/placeholder.svg');
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL, city TEXT NOT NULL,
  address TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id), qty INTEGER NOT NULL, price INTEGER NOT NULL);
`);

if (db.prepare('SELECT COUNT(*) c FROM products').get().c === 0) {
  const ins = db.prepare('INSERT INTO products(name,category,notes,price,stock) VALUES(?,?,?,?,?)');
  [
    ['Gulab Noir', 'Women', 'Damask rose, black pepper, oud', 12500, 25],
    ['Jasmine Veil', 'Women', 'Jasmine, pear, white musk', 10900, 30],
    ['Amber Hour', 'Unisex', 'Amber, saffron, vanilla', 11900, 40],
    ['Saffron Silk', 'Unisex', 'Saffron, iris, cedar', 11200, 18],
    ['Midnight Oud', 'Men', 'Oud, leather, sandalwood', 14200, 20],
    ['Cedar & Smoke', 'Men', 'Cedar, tobacco, vetiver', 12900, 22],
    ['Discovery Set', 'Gift Sets', '5 ml x 3 signatures', 4500, 60],
    ['Couple Gift Box', 'Gift Sets', 'One for him, one for her', 21500, 15],
  ].forEach(r => ins.run(...r));
}

const app = express();
app.use(express.json());

// ---------- Public API ----------
app.get('/api/products', (req, res) => {
  const { category } = req.query;
  const rows = category
    ? db.prepare('SELECT * FROM products WHERE category = ? ORDER BY id').all(category)
    : db.prepare('SELECT * FROM products ORDER BY id').all();
  res.json(rows);
});

app.get('/api/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'Product not found' });
});

app.post('/api/orders', (req, res) => {
  const { customer = {}, items = [] } = req.body || {};
  const { name, phone, city, address } = customer;
  if (!name || !phone || !city || !address) return res.status(400).json({ error: 'Name, phone, city and address are required' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

  try {
    const place = db.transaction(() => {
      let total = 0;
      const lines = items.map(it => {
        const qty = parseInt(it.qty, 10);
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(it.id);
        if (!p || !(qty > 0)) throw new Error('Invalid item in cart');
        if (p.stock < qty) throw new Error(p.name + ' has only ' + p.stock + ' left');
        total += p.price * qty; // price always comes from the database, never from the browser
        return { p, qty };
      });
      const o = db.prepare('INSERT INTO orders(name,phone,city,address,total) VALUES(?,?,?,?,?)')
        .run(name, phone, city, address, total);
      for (const { p, qty } of lines) {
        db.prepare('INSERT INTO order_items(order_id,product_id,qty,price) VALUES(?,?,?,?)').run(o.lastInsertRowid, p.id, qty, p.price);
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, p.id);
      }
      return { id: o.lastInsertRowid, total };
    });
    res.status(201).json(place());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Admin API ----------
const tokens = new Set();
app.post('/api/admin/login', (req, res) => {
  if ((req.body || {}).password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const t = crypto.randomBytes(24).toString('hex');
  tokens.add(t);
  res.json({ token: t });
});
const admin = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  tokens.has(t) ? next() : res.status(401).json({ error: 'Login required' });
};
app.get('/api/admin/orders', admin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  const itemsQ = db.prepare('SELECT oi.qty, oi.price, p.name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE order_id = ?');
  res.json(orders.map(o => ({ ...o, items: itemsQ.all(o.id) })));
});
app.patch('/api/admin/orders/:id', admin, (req, res) => {
  const ok = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
  if (!ok.includes((req.body || {}).status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/products', admin, (req, res) => {
  const { name, category, notes, price, stock, image } = req.body || {};
  if (!name || !category || !(price > 0)) return res.status(400).json({ error: 'name, category and price are required' });
  const r = db.prepare('INSERT INTO products(name,category,notes,price,stock,image) VALUES(?,?,?,?,?,?)')
    .run(name, category, notes || '', price, stock || 0, image || '/images/placeholder.svg');
  res.status(201).json({ id: r.lastInsertRowid });
});

// ---------- Frontend ----------
app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log('Ambara store running on http://localhost:' + PORT));
