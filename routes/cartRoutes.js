const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// ============================================================
// 1. LẤY GIỎ HÀNG (GET /api/cart/:userId) - ĐÃ CẬP NHẬT LOGIC GIÁ
// ============================================================
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(`
      SELECT 
        c.id as cart_id,
        c.product_id,
        c.quantity as cart_quantity, -- Số lượng khách muốn mua
        
        -- Thông tin sản phẩm
        p.name,
        p.image_url,
        p.unit,
        p.quantity as current_stock, -- Số lượng thực tế trong kho
        p.status as product_status,
        
        -- Logic Giá (Quan trọng)
        p.price as original_price,   -- Giá gốc
        p.sale_price,                -- Giá giảm (nếu có)
        
        -- Tự động chọn giá thấp nhất để hiển thị
        CASE 
            WHEN p.sale_price IS NOT NULL AND p.sale_price < p.price THEN p.sale_price
            ELSE p.price 
        END as current_price,

        p.seller_id,
        u.full_name as seller_name

      FROM CartItems c
      JOIN Products p ON c.product_id = p.id
      JOIN Users u ON p.seller_id = u.id
      WHERE c.user_id = $1
      ORDER BY c.added_at DESC
    `, [userId]);
    
    // Tính tổng tiền tạm tính của giỏ hàng (Frontend có thể tự tính lại cũng được)
    const cartItems = result.rows;
    const totalCartValue = cartItems.reduce((sum, item) => sum + (Number(item.current_price) * item.cart_quantity), 0);

    res.json({
        items: cartItems,
        total: totalCartValue
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi truy vấn giỏ hàng', detail: err.message });
  }
});

// ============================================================
// 2. THÊM VÀO GIỎ (POST /api/cart/add) - Logic cộng dồn
// ============================================================
router.post('/add', async (req, res) => {
  const { user_id, product_id, quantity } = req.body;

  if (!user_id || !product_id || !quantity) {
    return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
  }

  try {
    // A. Kiểm tra sản phẩm tồn tại và trạng thái
    const prodRes = await pool.query('SELECT quantity, status, name FROM Products WHERE id = $1', [product_id]);
    if (prodRes.rows.length === 0) {
      return res.status(404).json({ error: 'Sản phẩm không tồn tại' });
    }
    const product = prodRes.rows[0];

    if (product.status !== 'available' && product.status !== 'out_of_stock') { 
        // Cho phép thêm nếu out_of_stock? Thường là không, nhưng logic dưới chặn rồi.
        // Ở đây chỉ chặn nếu status là 'pending' hoặc 'rejected'
        return res.status(400).json({ error: `Sản phẩm "${product.name}" đang tạm ngừng kinh doanh` });
    }

    // B. Kiểm tra số lượng hiện có trong giỏ
    const cartRes = await pool.query(
      'SELECT quantity FROM CartItems WHERE user_id = $1 AND product_id = $2',
      [user_id, product_id]
    );
    
    const currentInCart = cartRes.rows.length > 0 ? cartRes.rows[0].quantity : 0;
    const newTotal = currentInCart + parseInt(quantity);

    // C. Kiểm tra tồn kho (Tổng trong giỏ + Muốn thêm > Kho thực tế)
    if (newTotal > product.quantity) {
      return res.status(400).json({ 
        error: `Kho chỉ còn ${product.quantity} sản phẩm (Giỏ bạn đang có ${currentInCart})` 
      });
    }

    // D. Thực hiện Thêm mới hoặc Cập nhật
    if (cartRes.rows.length > 0) {
      await pool.query(
        'UPDATE CartItems SET quantity = $1 WHERE user_id = $2 AND product_id = $3',
        [newTotal, user_id, product_id]
      );
    } else {
      await pool.query(
        'INSERT INTO CartItems (user_id, product_id, quantity, added_at) VALUES ($1, $2, $3, NOW())',
        [user_id, product_id, quantity]
      );
    }

    res.json({ message: 'Đã thêm vào giỏ hàng' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi thêm vào giỏ', detail: err.message });
  }
});

// ============================================================
// 3. CẬP NHẬT SỐ LƯỢNG (PUT /api/cart/update)
// ============================================================
router.put('/update', async (req, res) => {
  const { user_id, product_id, quantity } = req.body;
  const newQty = parseInt(quantity);

  if (newQty <= 0) return res.status(400).json({ error: 'Số lượng phải lớn hơn 0' });

  try {
    // Kiểm tra tồn kho
    const prodRes = await pool.query('SELECT quantity FROM Products WHERE id = $1', [product_id]);
    if (prodRes.rows.length === 0) return res.status(404).json({ error: 'Sản phẩm không tồn tại' });
    
    const stock = prodRes.rows[0].quantity;

    if (newQty > stock) {
      return res.status(400).json({ error: `Kho không đủ hàng (Chỉ còn ${stock})` });
    }

    // Cập nhật
    const result = await pool.query(
      'UPDATE CartItems SET quantity = $1 WHERE user_id = $2 AND product_id = $3 RETURNING *',
      [newQty, user_id, product_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sản phẩm chưa có trong giỏ' });
    }

    res.json({ message: 'Cập nhật thành công', item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi cập nhật giỏ', detail: err.message });
  }
});

// ============================================================
// 4. XÓA SẢN PHẨM (DELETE /api/cart/:userId/:productId)
// ============================================================
router.delete('/:userId/:productId', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM CartItems WHERE user_id = $1 AND product_id = $2 RETURNING *',
      [req.params.userId, req.params.productId]
    );
    
    if (result.rows.length === 0) {
        return res.json({ message: 'Sản phẩm không có trong giỏ hoặc đã bị xóa' });
    }

    res.json({ message: 'Đã xóa sản phẩm khỏi giỏ' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi xóa sản phẩm', detail: err.message });
  }
});

// ============================================================
// 5. XÓA TOÀN BỘ GIỎ (DELETE /api/cart/:userId/clear)
// ============================================================
router.delete('/:userId/clear', async (req, res) => {
  try {
    await pool.query('DELETE FROM CartItems WHERE user_id = $1', [req.params.userId]);
    res.json({ message: 'Đã làm trống giỏ hàng' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi xóa giỏ hàng', detail: err.message });
  }
});

module.exports = router;