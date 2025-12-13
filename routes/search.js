const express = require('express');
const router = express.Router();
const pool = require('../config/database');

/**
 * API TÌM KIẾM VÀ LỌC SẢN PHẨM NÂNG CAO
 * * Endpoint: GET / (khi gắn vào sẽ là /api/search)
 * * Các tham số query (Query Params):
 * - keyword: Từ khóa (tìm trong Tên sản phẩm, Mô tả)
 * - seller: Tên người bán (nông dân)
 * - location: Địa chỉ (của người bán)
 * - minPrice: Giá tối thiểu
 * - maxPrice: Giá tối đa
 * - categoryId: Lọc theo ID danh mục
 * - sortBy: Sắp xếp (vd: 'price_asc', 'price_desc', 'newest')
 */
router.get('/', async (req, res) => {
  try {
    // 1. Lấy tất cả tham số từ query string
    const { 
      keyword, 
      seller, 
      location, 
      minPrice, 
      maxPrice, 
      categoryId,
      sortBy 
    } = req.query;

    // 2. Bắt đầu câu truy vấn cơ bản
    // (Join với Users để lấy seller_name, address và Categories để lấy category_name)
    let baseQuery = `
      SELECT p.*, 
             u.full_name as seller_name, 
             u.address as seller_address, 
             c.name as category_name
      FROM Products p
      JOIN Users u ON p.seller_id = u.id
      LEFT JOIN Categories c ON p.category_id = c.id
    `;

    const conditions = []; // Mảng chứa các điều kiện WHERE
    const params = [];     // Mảng chứa các giá trị ($1, $2, $3...)

    // 3. Xây dựng các điều kiện (WHERE) động
    
    // Lọc theo Tên sản phẩm / Mô tả
    if (keyword) {
      params.push(`%${keyword}%`);
      conditions.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`);
    }

    // Lọc theo Tên người bán
    if (seller) {
      params.push(`%${seller}%`);
      conditions.push(`u.full_name ILIKE $${params.length}`);
    }

    // Lọc theo Địa chỉ (location của người bán)
    if (location) {
      params.push(`%${location}%`);
      conditions.push(`u.address ILIKE $${params.length}`);
    }

    // Lọc theo Giá tối thiểu
    if (minPrice) {
      params.push(minPrice);
      conditions.push(`p.price >= $${params.length}`);
    }

    // Lọc theo Giá tối đa
    if (maxPrice) {
      params.push(maxPrice);
      conditions.push(`p.price <= $${params.length}`);
    }
    
    // Lọc theo Danh mục
    if (categoryId) {
      params.push(categoryId);
      conditions.push(`p.category_id = $${params.length}`);
    }

    // 4. Ghép các điều kiện vào câu truy vấn
    if (conditions.length > 0) {
      baseQuery += ' WHERE ' + conditions.join(' AND ');
    }

    // 5. Xây dựng logic Sắp xếp (ORDER BY)
    let orderBy = ' ORDER BY p.created_at DESC'; // Mặc định: mới nhất
    if (sortBy === 'price_asc') {
      orderBy = ' ORDER BY p.price ASC';
    } else if (sortBy === 'price_desc') {
      orderBy = ' ORDER BY p.price DESC';
    }
    baseQuery += orderBy;

    // 6. Thực thi truy vấn
    const result = await pool.query(baseQuery, params);
    
    res.json(result.rows);

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Loi truy van tim kiem', detail: err.message });
  }
});

module.exports = router;