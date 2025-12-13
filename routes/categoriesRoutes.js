const express = require('express');
const router = express.Router();
const pool = require('../config/database'); 

// 1. Lấy tất cả danh mục (READ All)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM Categories ORDER BY name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Loi truy van database' });
  }
});

// 2. Lấy chi tiết danh mục theo id (READ One)
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM Categories WHERE id = $1`, 
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Khong tim thay danh muc' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Loi truy van database' });
  }
});

// 3. Thêm mới danh mục (CREATE)
router.post('/', async (req, res) => {
  try {
    const { name, description } = req.body;

    // Kiểm tra 'name' là bắt buộc (theo schema của bạn)
    if (!name) {
      return res.status(400).json({ error: 'Ten danh muc la bat buoc' });
    }

    const result = await pool.query(
      `INSERT INTO Categories (name, description) VALUES ($1, $2) RETURNING *`,
      [name, description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Loi them danh muc', detail: err.message });
  }
});

// 4. Cập nhật danh mục (UPDATE)
router.put('/:id', async (req, res) => {
  try {
    const { name, description } = req.body;

    // Kiểm tra 'name' là bắt buộc
    if (!name) {
      return res.status(400).json({ error: 'Ten danh muc la bat buoc' });
    }

    const result = await pool.query(
      `UPDATE Categories SET name=$1, description=$2 WHERE id=$3 RETURNING *`,
      [name, description, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Khong tim thay danh muc' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Loi cap nhat danh muc' });
  }
});

// 5. Xóa danh mục (DELETE)
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM Categories WHERE id=$1 RETURNING *', 
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Khong tim thay danh muc' });
    }
    
    // Giữ cấu trúc trả về giống file products.js
    res.json({ message: 'Xoa thanh cong', category: result.rows[0] }); 
  } catch (err) {
    res.status(500).json({ error: 'Loi xoa danh muc' });
  }
});

module.exports = router;