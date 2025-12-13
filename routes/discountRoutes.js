const express = require('express');
const router = express.Router();
const pool = require('../config/database'); // Đảm bảo đường dẫn đúng tới file cấu hình DB của bạn

// ============================================================
// 1. LẤY DANH SÁCH MÃ GIẢM GIÁ (Admin)
// ============================================================
router.get('/', async (req, res) => {
  try {
    // Sắp xếp theo ngày tạo mới nhất
    const result = await pool.query('SELECT * FROM Discounts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Get discounts error:', err);
    res.status(500).json({ error: 'Lỗi lấy danh sách mã giảm giá' });
  }
});

// ============================================================
// 2. TẠO MÃ GIẢM GIÁ MỚI (Admin)
// ============================================================
router.post('/', async (req, res) => {
  const { code, description, discount_percent, start_date, end_date, usage_limit } = req.body;

  // Validate cơ bản
  if (!code || !discount_percent || !start_date || !end_date) {
    return res.status(400).json({ error: 'Thiếu thông tin bắt buộc (Code, %, Ngày)' });
  }

  try {
    // Chuyển code về chữ in hoa để dễ quản lý
    const upperCode = code.toUpperCase();

    const result = await pool.query(
      `INSERT INTO Discounts 
       (code, description, discount_percent, start_date, end_date, usage_limit)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [upperCode, description, discount_percent, start_date, end_date, usage_limit || 1]
    );

    res.status(201).json({ message: 'Tạo mã thành công', discount: result.rows[0] });

  } catch (err) {
    if (err.code === '23505') { // Lỗi trùng mã (Unique violation)
        return res.status(400).json({ error: 'Mã giảm giá này đã tồn tại.' });
    }
    console.error('Create discount error:', err);
    res.status(500).json({ error: 'Lỗi tạo mã giảm giá' });
  }
});

// ============================================================
// 3. CẬP NHẬT MÃ GIẢM GIÁ (Admin)
// ============================================================
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { description, discount_percent, start_date, end_date, usage_limit, is_active } = req.body;

  try {
    const result = await pool.query(
      `UPDATE Discounts 
       SET description = $1, 
           discount_percent = $2, 
           start_date = $3, 
           end_date = $4, 
           usage_limit = $5, 
           is_active = $6
       WHERE id = $7
       RETURNING *`,
      [description, discount_percent, start_date, end_date, usage_limit, is_active, id]
    );

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Không tìm thấy mã giảm giá' });
    }

    res.json({ message: 'Cập nhật thành công', discount: result.rows[0] });

  } catch (err) {
    console.error('Update discount error:', err);
    res.status(500).json({ error: 'Lỗi cập nhật' });
  }
});

// ============================================================
// 4. XÓA MÃ GIẢM GIÁ (Admin)
// ============================================================
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM Discounts WHERE id = $1 RETURNING id', [req.params.id]);
    
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Không tìm thấy mã để xóa' });
    }
    res.json({ message: 'Đã xóa mã giảm giá' });
  } catch (err) {
    console.error('Delete discount error:', err);
    res.status(500).json({ error: 'Lỗi xóa mã' });
  }
});

// ============================================================
// 5. KIỂM TRA & ÁP DỤNG MÃ (User sử dụng ở trang Checkout)
// ============================================================
router.post('/validate', async (req, res) => {
    const { code } = req.body;

    if (!code) return res.status(400).json({ error: 'Vui lòng nhập mã giảm giá' });

    try {
        const upperCode = code.toUpperCase();
        
        // Lấy thông tin mã
        const result = await pool.query('SELECT * FROM Discounts WHERE code = $1', [upperCode]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Mã giảm giá không tồn tại' });
        }

        const discount = result.rows[0];
        const now = new Date();
        const startDate = new Date(discount.start_date);
        const endDate = new Date(discount.end_date);

        // --- CÁC BƯỚC KIỂM TRA LOGIC ---
        
        // 1. Kiểm tra trạng thái kích hoạt
        if (!discount.is_active) {
            return res.status(400).json({ error: 'Mã này hiện đang bị khóa.' });
        }

        // 2. Kiểm tra thời gian
        if (now < startDate) {
            return res.status(400).json({ error: 'Mã chưa đến thời gian áp dụng.' });
        }
        if (now > endDate) {
            return res.status(400).json({ error: 'Mã đã hết hạn sử dụng.' });
        }

        // 3. Kiểm tra số lượt dùng
        if (discount.used_count >= discount.usage_limit) {
            return res.status(400).json({ error: 'Mã này đã hết lượt sử dụng.' });
        }

        // NẾU HỢP LỆ: Trả về thông tin để Frontend trừ tiền
        res.json({
            success: true,
            discount_id: discount.id,
            code: discount.code,
            discount_percent: discount.discount_percent,
            message: `Áp dụng thành công! Giảm ${discount.discount_percent}%`
        });

    } catch (err) {
        console.error('Validate discount error:', err);
        res.status(500).json({ error: 'Lỗi kiểm tra mã' });
    }
});

module.exports = router;