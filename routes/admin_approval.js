const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// --- 1. Lấy tất cả sản phẩm đang chờ duyệt ---
// API: GET /api/admin/pending-products
router.get('/pending-products', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, u.full_name as seller_name, c.name as category_name
      FROM Products p
      JOIN Users u ON p.seller_id = u.id
      LEFT JOIN Categories c ON p.category_id = c.id
      WHERE p.status = 'pending_approval'
      ORDER BY p.created_at ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Lỗi lấy danh sách chờ duyệt:', err);
    res.status(500).json({ error: 'Lỗi truy vấn database', detail: err.message });
  }
});

// --- 2. Duyệt (Approve) một sản phẩm ---
// API: PATCH /api/admin/approve-product/:id
router.patch('/approve-product/:id', async (req, res) => {
  const client = await pool.connect(); // Sử dụng client để dùng Transaction
  try {
    await client.query('BEGIN'); // Bắt đầu giao dịch

    const { id } = req.params;

    // 1. Lấy thông tin sản phẩm
    const prodResult = await client.query(
      `SELECT * FROM Products WHERE id = $1 FOR UPDATE`, // Khóa dòng này lại để tránh race condition
      [id]
    );

    if (prodResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    const product = prodResult.rows[0];

    // Kiểm tra xem sản phẩm có đang chờ duyệt không
    if (product.status !== 'pending_approval') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sản phẩm không ở trạng thái chờ duyệt' });
    }

    // 2. Cập nhật trạng thái
    const updateResult = await client.query(
      `UPDATE Products 
       SET status = 'available', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    // 3. Tạo thông báo
    const notifyResult = await client.query(
      `INSERT INTO Notifications (user_id, type, title, message, product_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [
        product.seller_id,
        'product',
        'Sản phẩm đã được duyệt',
        `Sản phẩm "${product.name}" của bạn đã được duyệt và đang hiển thị trên sàn.`,
        product.id
      ]
    );

    await client.query('COMMIT'); // Xác nhận giao dịch thành công

    // 4. Gửi Socket Realtime (Sau khi commit DB thành công)
    sendRealtimeNotification(req, product.seller_id, notifyResult.rows[0]);

    res.json({ 
      message: 'Đã duyệt sản phẩm thành công', 
      product: updateResult.rows[0] 
    });

  } catch (err) {
    await client.query('ROLLBACK'); // Hoàn tác nếu có lỗi
    console.error('Lỗi duyệt sản phẩm:', err);
    res.status(500).json({ error: 'Lỗi hệ thống', detail: err.message });
  } finally {
    client.release(); // Trả kết nối về pool
  }
});

// --- 3. Từ chối (Reject) một sản phẩm ---
// API: PATCH /api/admin/reject-product/:id
// Body: { "reason": "Hình ảnh không rõ nét" }
router.patch('/reject-product/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let { id } = req.params;
    const { reason } = req.body; // Nhận lý do từ chối
    const rejectReason = reason || 'Vi phạm chính sách của sàn';

    id = parseInt(id, 10);
    if (isNaN(id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'ID sản phẩm không hợp lệ' });
    }

    // 1. Kiểm tra sản phẩm
    const prodResult = await client.query(`SELECT * FROM Products WHERE id = $1 FOR UPDATE`, [id]);
    
    if (prodResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    const product = prodResult.rows[0];

    if (product.status !== 'pending_approval') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sản phẩm không ở trạng thái chờ duyệt' });
    }

    // 2. Cập nhật trạng thái thành 'rejected' (Thay vì DELETE)
    // Điều này giúp giữ lại lịch sử và seller biết tại sao bị từ chối
    const updateResult = await client.query(
      `UPDATE Products 
       SET status = 'rejected', updated_at = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [id]
    );

    // 3. Tạo thông báo kèm lý do
    const notifyResult = await client.query(
      `INSERT INTO Notifications (user_id, type, title, message, product_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [
        product.seller_id,
        'product',
        'Sản phẩm bị từ chối',
        `Sản phẩm "${product.name}" bị từ chối. Lý do: ${rejectReason}`,
        product.id
      ]
    );

    await client.query('COMMIT');

    // 4. Gửi Socket
    sendRealtimeNotification(req, product.seller_id, notifyResult.rows[0]);

    res.json({ 
      message: 'Đã từ chối sản phẩm', 
      product: updateResult.rows[0],
      reason: rejectReason
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi từ chối sản phẩm:', err);
    res.status(500).json({ error: 'Lỗi hệ thống', detail: err.message });
  } finally {
    client.release();
  }
});

// --- 4. Tạo sản phẩm mới (Giữ nguyên logic nhưng làm sạch code) ---
router.post('/products', async (req, res) => {
  const allowedStatus = ['available', 'sold_out', 'pending_approval', 'rejected'];
  const { name, description, price, quantity, image_url, status, seller_id, category_id } = req.body;

  // Mặc định là pending_approval nếu không gửi status
  const productStatus = status || 'pending_approval';

  // Basic Validation
  if (!name || !price || !seller_id) {
    return res.status(400).json({ error: 'Thiếu thông tin bắt buộc (name, price, seller_id)' });
  }

  if (!allowedStatus.includes(productStatus)) {
    return res.status(400).json({ 
      error: 'Status không hợp lệ', 
      allowed: allowedStatus 
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO Products (name, description, price, quantity, image_url, status, seller_id, category_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING *`,
      [name, description, price, quantity, image_url, productStatus, seller_id, category_id]
    );
    res.status(201).json({ message: 'Tạo sản phẩm thành công', product: result.rows[0] });
  } catch (err) {
    console.error('Lỗi tạo sản phẩm:', err);
    res.status(500).json({ error: 'Lỗi tạo sản phẩm', detail: err.message });
  }
});

// --- Helper Function: Xử lý gửi Socket ---
const sendRealtimeNotification = (req, userId, notificationData) => {
  try {
    const io = req.app.get('io');
    if (!io) return;

    io.userSockets = io.userSockets || {};
    const socketIds = io.userSockets[userId];

    // Xử lý socketIds: Nó có thể là một chuỗi (1 thiết bị) hoặc mảng (nhiều thiết bị)
    // Code chuẩn nên lưu userSockets[userId] là một mảng []
    
    if (Array.isArray(socketIds)) {
        socketIds.forEach(socketId => {
            io.to(socketId).emit('notification', notificationData);
        });
        console.log(`Socket sent to User ${userId} on devices:`, socketIds);
    } else if (socketIds) {
        // Fallback nếu code cũ lưu 1 string
        io.to(socketIds).emit('notification', notificationData);
        console.log(`Socket sent to User ${userId} on device:`, socketIds);
    }
  } catch (error) {
    console.error('Lỗi gửi socket:', error);
  }
};

module.exports = router;