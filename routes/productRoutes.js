const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// --- CẤU HÌNH UPLOAD ---
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // Đặt tên file an toàn, tránh ký tự lạ
    cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-'));
  }
});
const upload = multer({ storage });

// ============================================================
// 1. LẤY DANH SÁCH SẢN PHẨM (Full tính năng: Rating, Sale, Sold)
// ============================================================
router.get('/', async (req, res) => {
  try {
    const { seller_id, keyword, minPrice, maxPrice, categoryId, location, sortBy } = req.query;

    // Dùng Subquery để tính toán chính xác, không cần GROUP BY phức tạp
    let query = `
      SELECT 
        p.*, 
        u.full_name as seller_name, 
        u.address as seller_address,
        c.name as category_name,
        
        -- Rating trung bình
        (SELECT COALESCE(AVG(rating), 0)::NUMERIC(10,1) FROM Reviews WHERE product_id = p.id) as rating,
        
        -- Số lượng đánh giá
        (SELECT COUNT(*)::INT FROM Reviews WHERE product_id = p.id) as review_count,

        -- Số lượng đã bán
        (SELECT COALESCE(SUM(quantity), 0) FROM OrderItems WHERE product_id = p.id)::INT as sold_count

      FROM Products p
      JOIN Users u ON p.seller_id = u.id
      LEFT JOIN Categories c ON p.category_id = c.id
      
      WHERE p.status != 'deleted'
    `;

    const params = [];
    let paramIndex = 1;

    // --- BỘ LỌC ---
    if (seller_id) {
      query += ` AND p.seller_id = $${paramIndex++}`;
      params.push(seller_id);
    }
    if (keyword) {
      query += ` AND p.name ILIKE $${paramIndex++}`;
      params.push(`%${keyword}%`);
    }
    
    // Lọc theo Giá (Ưu tiên lọc theo giá Sale nếu có)
    if (minPrice) {
      query += ` AND COALESCE(p.sale_price, p.price) >= $${paramIndex++}`;
      params.push(minPrice);
    }
    if (maxPrice) {
      query += ` AND COALESCE(p.sale_price, p.price) <= $${paramIndex++}`;
      params.push(maxPrice);
    }

    if (categoryId) {
      query += ` AND p.category_id = $${paramIndex++}`;
      params.push(categoryId);
    }
    if (location) {
      query += ` AND u.address ILIKE $${paramIndex++}`;
      params.push(`%${location}%`);
    }

    // --- SẮP XẾP ---
    if (sortBy === 'price_asc') {
      query += ` ORDER BY COALESCE(p.sale_price, p.price) ASC`;
    } else if (sortBy === 'price_desc') {
      query += ` ORDER BY COALESCE(p.sale_price, p.price) DESC`;
    } else {
      query += ` ORDER BY p.created_at DESC`;
    }

    const result = await pool.query(query, params);
    
    // Parse extra_images nếu DB trả về string
    const products = result.rows.map(prod => ({
      ...prod,
      extra_images: typeof prod.extra_images === 'string' ? JSON.parse(prod.extra_images) : (prod.extra_images || [])
    }));

    res.json(products);

  } catch (err) {
    console.error('Error getting products:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

// ============================================================
// 2. LẤY CHI TIẾT SẢN PHẨM
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         p.*, 
         u.full_name as seller_name, 
         c.name as category_name,
         (SELECT COALESCE(AVG(rating), 0)::NUMERIC(10,1) FROM Reviews WHERE product_id = p.id) as rating,
         (SELECT COUNT(*)::INT FROM Reviews WHERE product_id = p.id) as review_count,
         (SELECT COALESCE(SUM(quantity), 0) FROM OrderItems WHERE product_id = p.id) as sold_count
       FROM Products p
       JOIN Users u ON p.seller_id = u.id
       LEFT JOIN Categories c ON p.category_id = c.id
       WHERE p.id = $1 AND p.status != 'deleted'`, 
      [req.params.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });

    const product = result.rows[0];
    product.extra_images = typeof product.extra_images === 'string' ? JSON.parse(product.extra_images) : (product.extra_images || []);

    res.json(product);
  } catch (err) {
    console.error('Get detail error:', err);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// ============================================================
// 3. THÊM SẢN PHẨM MỚI (Có Sale Price & Unit)
// ============================================================
router.post('/', upload.fields([
  { name: 'image_url', maxCount: 1 }, 
  { name: 'extra_images', maxCount: 10 }
]), async (req, res) => {
  try {
    const { name, description, price, quantity, unit, category_id, sale_price } = req.body;
    let { seller_id } = req.body;

    // Logic check seller (giả sử lấy từ token hoặc body)
    if (!seller_id && req.user) seller_id = req.user.id;
    if (!seller_id) return res.status(400).json({ error: 'Thiếu seller_id' });

    // --- XỬ LÝ LOGIC GIÁ ---
    const originalPrice = parseFloat(price);
    const promotionPrice = sale_price ? parseFloat(sale_price) : originalPrice;

    if (promotionPrice > originalPrice) {
        return res.status(400).json({ error: 'Giá khuyến mãi không được cao hơn giá gốc!' });
    }

    // Xử lý ảnh chính
    let image_url = null;
    if (req.files['image_url'] && req.files['image_url'][0]) {
      image_url = `/uploads/${req.files['image_url'][0].filename}`;
    } else if (req.body.image_url) {
        image_url = req.body.image_url;
    }

    // Xử lý ảnh phụ
    let extra_images = [];
    if (req.files['extra_images']) {
      extra_images = req.files['extra_images'].map(f => `/uploads/${f.filename}`);
    }

    const result = await pool.query(
      `INSERT INTO Products 
       (name, description, price, sale_price, quantity, unit, image_url, extra_images, status, seller_id, category_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
       RETURNING *`,
      [
        name, 
        description, 
        originalPrice,
        promotionPrice, // Lưu giá sale
        parseInt(quantity), 
        unit || 'kg', 
        image_url, 
        JSON.stringify(extra_images), 
        'pending_approval', 
        seller_id, 
        parseInt(category_id)
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Lỗi thêm sản phẩm', detail: err.message });
  }
});

// ============================================================
// 4. CẬP NHẬT SẢN PHẨM (Có Sale Price)
// ============================================================
router.put('/:id', upload.fields([
  { name: 'image_url', maxCount: 1 },
  { name: 'extra_images', maxCount: 10 }
]), async (req, res) => {
  const { id } = req.params;
  const { name, description, price, quantity, unit, category_id, sale_price } = req.body;

  try {
    // Lấy dữ liệu cũ
    const oldProd = await pool.query('SELECT image_url, extra_images FROM Products WHERE id = $1', [id]);
    if (oldProd.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    // --- XỬ LÝ LOGIC GIÁ ---
    const originalPrice = parseFloat(price);
    const promotionPrice = sale_price ? parseFloat(sale_price) : originalPrice;

    if (promotionPrice > originalPrice) {
        return res.status(400).json({ error: 'Giá khuyến mãi không được cao hơn giá gốc!' });
    }

    // Xử lý ảnh phụ
    let currentExtra = oldProd.rows[0].extra_images || [];
    if (typeof currentExtra === 'string') currentExtra = JSON.parse(currentExtra);

    // Ảnh chính
    let final_image_url = oldProd.rows[0].image_url;
    if (req.files['image_url'] && req.files['image_url'][0]) {
        final_image_url = `/uploads/${req.files['image_url'][0].filename}`;
    } else if (req.body.image_url) {
        final_image_url = req.body.image_url;
    }

    // Ảnh phụ mới
    let final_extra = currentExtra;
    if (req.files['extra_images']) {
        const newPaths = req.files['extra_images'].map(f => `/uploads/${f.filename}`);
        final_extra = [...final_extra, ...newPaths];
    }

    const result = await pool.query(
      `UPDATE Products
       SET name=$1, description=$2, price=$3, sale_price=$4, quantity=$5, unit=$6, 
           image_url=$7, extra_images=$8, category_id=$9, 
           status='pending_approval', updated_at=NOW()
       WHERE id=$10
       RETURNING *`,
      [
        name, description, originalPrice, promotionPrice, parseInt(quantity), unit || 'kg',
        final_image_url, JSON.stringify(final_extra), parseInt(category_id), id
      ]
    );

    // Thông báo Admin
    await pool.query(
        `INSERT INTO Notifications (user_id, type, title, message, created_at)
         VALUES (1, 'system', 'Sản phẩm cập nhật', $1, NOW())`,
        [`Sản phẩm "${name}" cần được duyệt lại.`]
    );

    res.json({ message: 'Cập nhật thành công', product: result.rows[0] });
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
});

// ============================================================
// 5. XÓA SẢN PHẨM (Soft Delete)
// ============================================================
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const check = await pool.query('SELECT status FROM Products WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (check.rows[0].status === 'deleted') return res.status(400).json({ error: 'Đã xóa rồi' });

    const result = await pool.query(
      `UPDATE Products SET status='deleted', quantity=0, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id]
    );

    res.json({ message: 'Đã xóa mềm sản phẩm', product: result.rows[0] });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

// ============================================================
// 6. XÓA ẢNH PHỤ
// ============================================================
router.delete('/:id/extra-images/:index', async (req, res) => {
  const { id, index } = req.params;
  try {
    const prod = await pool.query('SELECT extra_images FROM Products WHERE id=$1', [id]);
    if (prod.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    let images = prod.rows[0].extra_images || [];
    if (typeof images === 'string') images = JSON.parse(images);

    const idx = parseInt(index);
    if (idx < 0 || idx >= images.length) return res.status(400).json({ error: 'Index sai' });

    const imagePathToRemove = images[idx];
    images.splice(idx, 1);

    const update = await pool.query(
      'UPDATE Products SET extra_images=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [JSON.stringify(images), id]
    );

    if (imagePathToRemove && imagePathToRemove.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, '..', imagePathToRemove);
        fs.unlink(filePath, (err) => { if(err) console.warn('Không thể xóa file:', filePath); });
    }

    res.json({ message: 'Đã xóa ảnh phụ', product: update.rows[0] });
  } catch (err) {
    console.error('Delete extra image error:', err);
    res.status(500).json({ error: 'Lỗi server' });
  }
});

module.exports = router;