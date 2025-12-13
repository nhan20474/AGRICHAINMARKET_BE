module.exports = (io) => {
  const express = require('express');
  const router = express.Router();
  const pool = require('../config/database');

  // --- HELPER: Hàm gửi Socket Realtime ---
  const sendRealtimeToUser = (userId, data) => {
    if (!io || !io.userSockets) return;
    
    const sockets = io.userSockets[userId];
    // Xử lý nếu sockets là mảng (nhiều thiết bị) hoặc chuỗi (1 thiết bị)
    if (Array.isArray(sockets)) {
      sockets.forEach(socketId => io.to(socketId).emit('notification', data));
    } else if (sockets) {
      io.to(sockets).emit('notification', data);
    }
  };

  // --- 1. Lấy thông báo đơn hàng (Fake notification từ trạng thái đơn) ---
  router.get('/orders/:userId', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, status, created_at, total_amount
         FROM Orders
         WHERE buyer_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [req.params.userId]
      );
      
      const notifications = result.rows.map(order => {
        let message = '';
        switch (order.status) {
          case 'pending': message = `Đơn hàng #${order.id} đang chờ xử lý.`; break;
          case 'processing': message = `Đơn hàng #${order.id} đang được chuẩn bị.`; break;
          case 'shipped': message = `Đơn hàng #${order.id} đã được gửi đi.`; break;
          case 'delivered': message = `Đơn hàng #${order.id} đã giao thành công.`; break;
          case 'cancelled': message = `Đơn hàng #${order.id} đã bị hủy.`; break;
          default: message = `Đơn hàng #${order.id} trạng thái: ${order.status}.`;
        }
        return {
          order_id: order.id,
          status: order.status,
          created_at: order.created_at,
          total_amount: order.total_amount,
          message,
          type: 'order_tracking'
        };
      });
      res.json(notifications);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Lỗi lấy thông báo đơn hàng' });
    }
  });

  // --- 2. Lấy thông báo sản phẩm bị từ chối (Cho Seller) ---
  router.get('/products/:sellerId', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, name, status, updated_at as created_at
         FROM Products
         WHERE seller_id = $1 AND status = 'rejected'
         ORDER BY updated_at DESC LIMIT 10`,
        [req.params.sellerId]
      );
      const notifications = result.rows.map(prod => ({
        product_id: prod.id,
        name: prod.name,
        status: prod.status,
        created_at: prod.created_at,
        message: `Sản phẩm "${prod.name}" đã bị từ chối.`,
        type: 'product_rejected'
      }));
      res.json(notifications);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Lỗi lấy thông báo sản phẩm' });
    }
  });

  // --- 3. Tạo thông báo cá nhân (Gửi cho 1 người) ---
  router.post('/', async (req, res) => {
    const { user_id, type, title, message, product_id, order_id } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO Notifications (user_id, type, title, message, product_id, order_id, created_at, is_read)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), FALSE) 
         RETURNING *`,
        [user_id, type, title, message, product_id || null, order_id || null]
      );
      
      const newNoti = result.rows[0];
      
      // Gửi socket
      sendRealtimeToUser(user_id, newNoti);

      res.status(201).json(newNoti);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Lỗi tạo thông báo', detail: err.message });
    }
  });

  // --- 4. BROADCAST: Gửi thông báo cho TẤT CẢ user ---
  router.post('/broadcast', async (req, res) => {
    const { type, title, message, product_id, order_id } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO Notifications (user_id, type, title, message, product_id, order_id, created_at, is_read)
         SELECT id, $1, $2, $3, $4, $5, NOW(), FALSE
         FROM Users
         RETURNING id, user_id, type, title, message, product_id, order_id, created_at, is_read`,
        [type, title, message, product_id || null, order_id || null]
      );

      if (io && io.userSockets) {
        result.rows.forEach(noti => {
           sendRealtimeToUser(noti.user_id, noti);
        });
      }

      res.status(201).json({ 
        message: 'Đã gửi thông báo broadcast thành công', 
        count: result.rowCount 
      });
    } catch (err) {
      console.error('Lỗi Broadcast:', err);
      res.status(500).json({ error: 'Lỗi gửi thông báo hàng loạt', detail: err.message });
    }
  });

  // --- 5. Lấy danh sách thông báo (Phân trang & Lọc) ---
  router.get('/user/:userId', async (req, res) => {
    const { page = 1, pageSize = 10, is_read } = req.query;
    const limit = parseInt(pageSize);
    const offset = (parseInt(page) - 1) * limit;
    
    let query = `SELECT * FROM Notifications WHERE user_id = $1`;
    let countQuery = `SELECT COUNT(*) FROM Notifications WHERE user_id = $1`;
    let params = [req.params.userId];
    
    if (is_read === 'true' || is_read === 'false') {
      query += ` AND is_read = $2`;
      countQuery += ` AND is_read = $2`;
      params.push(is_read === 'true');
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    
    try {
      const [dataResult, countResult] = await Promise.all([
        pool.query(query, [...params, limit, offset]),
        pool.query(countQuery, params)
      ]);

      res.json({
        notifications: dataResult.rows,
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        pageSize: limit
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Lỗi lấy danh sách thông báo' });
    }
  });

  // --- 6. Đánh dấu đã đọc ---
  router.patch('/read/:id', async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE Notifications SET is_read = TRUE WHERE id = $1 RETURNING *`,
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Lỗi cập nhật' });
    }
  });

  // --- 7. Đếm số lượng chưa đọc ---
  router.get('/user/:userId/unread-count', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT COUNT(*) FROM Notifications WHERE user_id = $1 AND is_read = FALSE`,
        [req.params.userId]
      );
      res.json({ unread_count: parseInt(result.rows[0].count) });
    } catch (err) {
      res.status(500).json({ error: 'Lỗi đếm thông báo' });
    }
  });

  // --- 8. Xóa thông báo (Theo ID) ---
  router.delete('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        `DELETE FROM Notifications WHERE id = $1 RETURNING *`,
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy' });
      res.json({ message: 'Đã xóa', id: req.params.id });
    } catch (err) {
      res.status(500).json({ error: 'Lỗi xóa' });
    }
  });

  // --- 9. (MỚI) Dọn dẹp thông báo cũ (Auto-Cleanup) ---
  // API: DELETE /api/notifications/cleanup?days=30
  router.delete('/cleanup', async (req, res) => {
    const { days } = req.query;
    
    const daysNum = parseInt(days);
    if (isNaN(daysNum) || daysNum < 1) {
      return res.status(400).json({ error: 'Số ngày không hợp lệ' });
    }

    try {
      // Xóa các thông báo cũ hơn số ngày quy định
      const result = await pool.query(
        `DELETE FROM Notifications 
         WHERE created_at < NOW() - ($1 || ' days')::INTERVAL 
         RETURNING id`,
        [daysNum]
      );

      res.json({ 
        message: `Đã dọn dẹp thành công`, 
        deleted_count: result.rowCount 
      });
    } catch (err) {
      console.error('Cleanup Error:', err);
      res.status(500).json({ error: 'Lỗi khi dọn dẹp dữ liệu', detail: err.message });
    }
  });

  // --- 10. (MỚI) Lấy TOÀN BỘ lịch sử thông báo (Dành cho Super Admin) ---
  // API: GET /api/notifications/admin/all-logs
  router.get('/admin/all-logs', async (req, res) => {
    const { page = 1, pageSize = 20, type } = req.query;
    const limit = parseInt(pageSize);
    const offset = (parseInt(page) - 1) * limit;

    try {
      // Query này lấy tất cả thông báo, kèm tên người gửi và người nhận
      let query = `
        SELECT n.*, 
               sender.full_name as sender_name,
               receiver.full_name as receiver_name
        FROM Notifications n
        LEFT JOIN Users sender ON n.sender_id = sender.id
        JOIN Users receiver ON n.user_id = receiver.id
        WHERE 1=1 
      `;
      
      let countQuery = `SELECT COUNT(*) FROM Notifications n WHERE 1=1`;
      let params = [];

      // Lọc theo loại nếu cần
      if (type && type !== 'all') {
        query += ` AND n.type = $1`;
        countQuery += ` AND type = $1`;
        params.push(type);
      }

      query += ` ORDER BY n.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

      const [data, count] = await Promise.all([
        pool.query(query, [...params, limit, offset]),
        pool.query(countQuery, params)
      ]);

      res.json({
        logs: data.rows,
        total: parseInt(count.rows[0].count),
        page: parseInt(page),
        pageSize: limit
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Lỗi lấy lịch sử hệ thống' });
    }
  });

  return router;
};