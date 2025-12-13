const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// ============================================================
// 1. TẠO ĐÁNH GIÁ MỚI (POST /api/reviews)
// ============================================================
router.post('/', async (req, res) => {
  const { order_id, product_id, user_id, rating, comment } = req.body;
  
  if (!order_id || !product_id || !user_id || rating == null) {
    return res.status(400).json({ error: 'Thiếu dữ liệu bắt buộc' });
  }

  try {
    // BƯỚC 1: Kiểm tra điều kiện (Đã mua hàng + Đã giao thành công)
    const checkOrder = await pool.query(`
        SELECT 1 
        FROM OrderItems oi
        JOIN Orders o ON oi.order_id = o.id
        WHERE o.id = $1 
          AND oi.product_id = $2 
          AND o.buyer_id = $3
          AND o.status IN ('delivered', 'received')
    `, [order_id, product_id, user_id]);

    if (checkOrder.rows.length === 0) {
        return res.status(400).json({ error: 'Bạn chưa mua sản phẩm này hoặc đơn hàng chưa hoàn tất.' });
    }

    // BƯỚC 2: Insert vào bảng Reviews
    const result = await pool.query(
      `INSERT INTO Reviews (order_id, product_id, user_id, rating, comment, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [order_id, product_id, user_id, rating, comment || null]
    );

    res.status(201).json(result.rows[0]);

  } catch (err) {
    // Bắt lỗi trùng lặp (User đã đánh giá rồi)
    if (err.code === '23505') {
        return res.status(400).json({ error: 'Bạn đã đánh giá sản phẩm này trong đơn hàng này rồi.' });
    }
    console.error('Lỗi tạo đánh giá:', err);
    res.status(500).json({ error: 'Lỗi server khi tạo đánh giá', detail: err.message });
  }
});

// ============================================================
// 2. LẤY DANH SÁCH ĐÁNH GIÁ CỦA 1 SẢN PHẨM (GET /api/reviews/product/:productId)
// ============================================================
router.get('/product/:productId', async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (isNaN(productId)) return res.status(400).json({ error: 'ID sản phẩm lỗi' });

  try {
    const result = await pool.query(
      `SELECT r.*, u.full_name AS user_name
       FROM Reviews r
       JOIN Users u ON u.id = r.user_id
       WHERE r.product_id = $1
       ORDER BY r.created_at DESC`,
      [productId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi lấy đánh giá', detail: err.message });
  }
});

// ============================================================
// 3. THỐNG KÊ SAO TRUNG BÌNH (GET /api/reviews/product/:productId/summary)
// ============================================================
router.get('/product/:productId/summary', async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (isNaN(productId)) return res.status(400).json({ error: 'ID sản phẩm lỗi' });

  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(AVG(rating), 0)::numeric(10,1) AS avg_rating
       FROM Reviews WHERE product_id = $1`,
      [productId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi thống kê', detail: err.message });
  }
});

// ============================================================
// 4. CÁC API KHÁC (User, Seller, Update, Delete)
// ============================================================

// Lấy đánh giá theo Seller
router.get('/seller/:sellerId', async (req, res) => {
  const sellerId = parseInt(req.params.sellerId, 10);
  try {
    const result = await pool.query(
      `SELECT r.*, p.name AS product_name, u.full_name AS user_name
       FROM Reviews r
       JOIN Products p ON p.id = r.product_id
       JOIN Users u ON u.id = r.user_id
       WHERE p.seller_id = $1
       ORDER BY r.created_at DESC`,
      [sellerId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi lấy đánh giá seller', detail: err.message });
  }
});

// Lấy đánh giá của 1 User
router.get('/user/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, p.name AS product_name
       FROM Reviews r
       JOIN Products p ON p.id = r.product_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi lấy đánh giá user', detail: err.message });
  }
});

// Cập nhật đánh giá (PUT)
router.put('/:id', async (req, res) => {
  const { rating, comment } = req.body;
  if (!rating) return res.status(400).json({ error: 'Thiếu rating' });

  try {
    const result = await pool.query(
      `UPDATE Reviews
       SET rating = $1, comment = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [rating, comment || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi cập nhật', detail: err.message });
  }
});

// Xóa đánh giá (DELETE)
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM Reviews WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json({ message: 'Đã xóa', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi xóa', detail: err.message });
  }
});

module.exports = router;