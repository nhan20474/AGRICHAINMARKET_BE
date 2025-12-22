const express = require('express');
const router = express.Router();
const pool = require('../config/database');

/* ================== HELPER ================== */
async function checkAdmin(admin_id) {
  if (!admin_id) return false;

  try {
    const res = await pool.query(
      'SELECT role FROM Users WHERE id = $1 AND role = $2',
      [admin_id, 'admin']
    );
    return res.rows.length > 0 && res.rows[0].role === 'admin';
  } catch (err) {
    console.error('Error in checkAdmin:', err);
    return false;
  }
}

/* =====================================================
   GET /api/admin/orders/statistics?admin_id=1
   Thống kê đơn hàng
===================================================== */
router.get('/orders/statistics', async (req, res) => {
  const { admin_id } = req.query;

  if (!(await checkAdmin(admin_id))) {
    return res.status(403).json({ error: 'Không có quyền admin' });
  }

  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::INTEGER AS total_orders,
        COUNT(*) FILTER (WHERE status='delivered' OR status='received')::INTEGER AS success_orders,
        COUNT(*) FILTER (WHERE status='cancelled')::INTEGER AS cancelled_orders,
        COALESCE(
          SUM(total_amount) FILTER (WHERE status='delivered' OR status='received'),
          0
        )::DECIMAL AS revenue
      FROM Orders
    `);

    res.json(rows[0]);
  } catch (err) {
    console.error('Statistics error:', err.message);
    res.status(500).json({ error: 'Không thể lấy thống kê', details: err.message });
  }
});

/* =====================================================
   GET /api/admin/orders?admin_id=1&status=pending
   Lấy toàn bộ đơn hàng trên sàn
===================================================== */
router.get('/orders', async (req, res) => {
  try {
    const { admin_id, status, limit } = req.query;

    const adminId = Number(admin_id);
    if (!Number.isInteger(adminId)) {
      return res.status(400).json({ error: 'admin_id không hợp lệ' });
    }


    if (!(await checkAdmin(adminId))) {
      return res.status(403).json({ error: 'Không có quyền admin' });
    }

    let query = `
      SELECT
        o.id,
        o.total_amount,
        o.status,
        o.created_at,
        buyer.full_name AS buyer_name,
        seller.full_name AS farmer_name
      FROM Orders o
      LEFT JOIN Users buyer ON o.buyer_id = buyer.id
      LEFT JOIN Users seller ON o.seller_id = seller.id
      WHERE 1=1
    `;

    const params = [];

    if (status) {
      params.push(status);
      query += ` AND o.status = $${params.length}`;
    }

    query += ' ORDER BY o.created_at DESC';

    if (limit) {
      params.push(Number(limit));
      query += ` LIMIT $${params.length}`;
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);

  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({
      error: 'Không thể lấy danh sách đơn hàng',
      details: err.message
    });
  }
});

/* =====================================================
   GET /api/admin/orders/:id?admin_id=1
   Chi tiết 1 đơn hàng
===================================================== */
router.get('/orders/:id', async (req, res) => {
  const { admin_id } = req.query;
  const orderId = req.params.id;

  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });
  }

  if (!(await checkAdmin(admin_id))) {
    return res.status(403).json({ error: 'Không có quyền admin' });
  }

  try {
    const orderRes = await pool.query(`
      SELECT
        o.*,
        buyer.full_name AS buyer_name,
        seller.full_name AS farmer_name
      FROM Orders o
      LEFT JOIN Users buyer ON o.buyer_id = buyer.id
      LEFT JOIN Users seller ON o.seller_id = seller.id
      WHERE o.id = $1
    `, [orderId]);

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Đơn hàng không tồn tại' });
    }

    const itemsRes = await pool.query(`
      SELECT
        oi.id,
        p.name AS product_name,
        oi.quantity,
        oi.price_per_item
      FROM OrderItems oi
      LEFT JOIN Products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
    `, [orderId]);

    res.json({
      order: orderRes.rows[0],
      items: itemsRes.rows
    });
  } catch (err) {
    console.error('Get order detail error:', err.message);
    res.status(500).json({ error: 'Lỗi lấy chi tiết đơn hàng', details: err.message });
  }
});

/* =====================================================
   PUT /api/admin/orders/:id/cancel
   Admin hủy TOÀN BỘ đơn
===================================================== */
router.put('/orders/:id/cancel', async (req, res) => {
  const { admin_id } = req.body;
  const orderId = req.params.id;

  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ error: 'ID đơn hàng không hợp lệ' });
  }

  if (!(await checkAdmin(admin_id))) {
    return res.status(403).json({ error: 'Không có quyền admin' });
  }

  try {
    await pool.query(
      `UPDATE Orders SET status = 'cancelled' WHERE id = $1`,
      [orderId]
    );

    await pool.query(
      `UPDATE OrderItems SET status = 'cancelled' WHERE order_id = $1`,
      [orderId]
    );

    res.json({ message: 'Admin đã hủy đơn hàng' });
  } catch (err) {
    console.error('Cancel order error:', err.message);
    res.status(500).json({ error: 'Hủy đơn hàng thất bại', details: err.message });
  }
});

module.exports = router;
