const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// --- HELPER: Gửi Socket Realtime ---
const sendRealtimeNotification = (req, userId, notificationData) => {
    try {
        const io = req.app.get('io'); 
        if (!io || !io.userSockets) return;

        const sockets = io.userSockets[userId];
        if (Array.isArray(sockets)) {
            sockets.forEach(socketId => io.to(socketId).emit('notification', notificationData));
        } else if (sockets) {
            io.to(sockets).emit('notification', notificationData);
        }
    } catch (err) {
        console.error('Socket Error:', err);
    }
};

// Tạo hoặc cập nhật thông tin vận chuyển cho đơn hàng
router.post('/:orderId', async (req, res) => {
  const { shipping_company, tracking_number, shipping_status, shipped_at, delivered_at, product_id } = req.body;
  
  // THÊM: Validation đầu vào
  if (!product_id) {
    return res.status(400).json({ error: 'Thiếu product_id - Không thể xác định sản phẩm cần cập nhật' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('🚚 Shipping POST data:', {
      orderId: req.params.orderId,
      product_id,
      shipping_status,
      shipping_company,
      tracking_number
    });

    // Kiểm tra đơn hàng có tồn tại không
    const orderCheck = await client.query(
      `SELECT id, buyer_id, seller_id FROM Orders WHERE id = $1`,
      [req.params.orderId]
    );
    if (orderCheck.rows.length === 0) {
      throw new Error('Không tìm thấy đơn hàng để cập nhật vận chuyển');
    }
    const order = orderCheck.rows[0];

    // THÊM: Kiểm tra sản phẩm có thuộc đơn hàng này không
    const productCheck = await client.query(
      `SELECT product_id FROM OrderItems WHERE order_id = $1 AND product_id = $2`,
      [req.params.orderId, product_id]
    );

    if (productCheck.rows.length === 0) {
      throw new Error(`Sản phẩm #${product_id} không thuộc đơn hàng #${req.params.orderId}`);
    }

    // SỬA: UPSERT với xử lý NULL values
    const result = await client.query(
      `INSERT INTO ShippingInfo 
        (order_id, product_id, shipping_company, tracking_number, shipping_status, shipped_at, delivered_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (order_id, product_id) 
       DO UPDATE SET 
          shipping_company = COALESCE(EXCLUDED.shipping_company, ShippingInfo.shipping_company),
          tracking_number = COALESCE(EXCLUDED.tracking_number, ShippingInfo.tracking_number),
          shipping_status = EXCLUDED.shipping_status,
          shipped_at = CASE 
              WHEN EXCLUDED.shipping_status IN ('shipped', 'delivered') AND ShippingInfo.shipped_at IS NULL 
              THEN NOW() 
              ELSE COALESCE(EXCLUDED.shipped_at, ShippingInfo.shipped_at)
          END,
          delivered_at = CASE 
              WHEN EXCLUDED.shipping_status = 'delivered' AND ShippingInfo.delivered_at IS NULL 
              THEN NOW() 
              ELSE COALESCE(EXCLUDED.delivered_at, ShippingInfo.delivered_at)
          END,
          updated_at = NOW()
       RETURNING *`,
      [
        req.params.orderId, 
        product_id, 
        shipping_company || null, 
        tracking_number || null, 
        shipping_status, 
        shipped_at || null, 
        delivered_at || null
      ]
    );

    console.log('✅ ShippingInfo UPSERT result:', result.rows[0]);

    // Kiểm tra TẤT CẢ sản phẩm trong đơn để cập nhật trạng thái tổng thể
    const allProducts = await client.query(
      `SELECT shipping_status FROM ShippingInfo WHERE order_id = $1`,
      [req.params.orderId]
    );

    let orderStatus = 'processing';
    const allStatuses = allProducts.rows.map(r => r.shipping_status);
    
    console.log('📦 Trạng thái các sản phẩm:', allStatuses);

    if (allStatuses.every(s => s === 'delivered')) {
      orderStatus = 'delivered';
    } else if (allStatuses.every(s => s === 'shipped' || s === 'delivered')) {
      orderStatus = 'shipped';
    } else if (allStatuses.every(s => s === 'cancelled')) {
      orderStatus = 'cancelled';
    }

    // Cập nhật trạng thái đơn hàng
    await client.query(
      `UPDATE Orders SET status = $1 WHERE id = $2`,
      [orderStatus, req.params.orderId]
    );

    console.log(`✅ Đơn hàng #${req.params.orderId} → Trạng thái mới: ${orderStatus}`);

    // Tạo thông báo cho Buyer
    const notificationMessages = {
      'pending': { icon: '⏳', message: 'Đơn hàng đang chờ xử lý' },
      'processing': { icon: '📦', message: 'Đơn hàng đang được chuẩn bị' },
      'shipped': { icon: '🚚', message: 'Đơn hàng đã được gửi đi' },
      'delivered': { icon: '📍', message: 'Đơn hàng đã được giao đến địa chỉ' }
    };

    const notiConfig = notificationMessages[shipping_status];
    if (notiConfig) {
      const notiResult = await client.query(
        `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, product_id, created_at)
         VALUES ($1, $2, 'order_tracking', $3, $4, $5, $6, NOW()) RETURNING *`,
        [
          order.buyer_id,
          order.seller_id,
          `${notiConfig.icon} ${notiConfig.message}`,
          `Đơn hàng #${req.params.orderId}: ${notiConfig.message}`,
          req.params.orderId,
          product_id
        ]
      );

      sendRealtimeNotification(req, order.buyer_id, notiResult.rows[0]);
    }

    await client.query('COMMIT');
    res.json({ 
      success: true,
      message: 'Cập nhật thông tin vận chuyển thành công', 
      shipping: result.rows[0],
      order_status: orderStatus
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Shipping update error:', err);
    res.status(500).json({ 
      error: 'Lỗi cập nhật thông tin vận chuyển', 
      detail: err.message,
      hint: 'Kiểm tra lại product_id và order_id có đúng không'
    });
  } finally {
    client.release();
  }
});

// Lấy thông tin vận chuyển của đơn hàng
router.get('/:orderId', async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId, 10);
    if (isNaN(orderId)) {
      return res.status(400).json({ error: 'orderId không hợp lệ' });
    }
    const result = await pool.query(
      `SELECT * FROM ShippingInfo WHERE order_id = $1`,
      [orderId]
    );
    if (result.rows.length === 0) {
      // Kiểm tra đơn hàng có tồn tại không
      const orderCheck = await pool.query(
        `SELECT id FROM Orders WHERE id = $1`,
        [orderId]
      );
      if (orderCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Không tìm thấy đơn hàng này' });
      }
      // Đơn hàng tồn tại nhưng chưa có thông tin vận chuyển
      return res.status(200).json({ message: 'Đơn hàng chưa có thông tin vận chuyển', shipping: null });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Lỗi lấy thông tin vận chuyển:', err);
    res.status(500).json({ error: 'Lỗi lấy thông tin vận chuyển', detail: err.message });
  }
});

// Lấy tất cả thông tin vận chuyển của các đơn hàng (cho admin)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM ShippingInfo ORDER BY updated_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi lấy danh sách vận chuyển', detail: err.message });
  }
});

// Lấy tất cả thông tin vận chuyển của các đơn hàng của một người dùng (buyer)
router.get('/by-user/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'userId không hợp lệ' });
    }
    // Lấy tất cả shipping info của các đơn hàng mà buyer_id = userId
    const result = await pool.query(
      `SELECT s.*
         FROM ShippingInfo s
         JOIN Orders o ON s.order_id = o.id
         WHERE o.buyer_id = $1
         ORDER BY s.updated_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi lấy danh sách vận chuyển của người dùng', detail: err.message });
  }
});

// Xóa thông tin vận chuyển khi đơn hàng bị hủy
router.delete('/:orderId', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM ShippingInfo WHERE order_id = $1 RETURNING *`,
      [req.params.orderId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy thông tin vận chuyển để xóa' });
    res.json({ message: 'Xóa thông tin vận chuyển thành công', shipping: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi xóa thông tin vận chuyển', detail: err.message });
  }
});

// ✅ API cập nhật trạng thái đơn hàng (cho Buyer xác nhận đã nhận hàng)
router.put('/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    // Validate status
    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'received', 'cancelled'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Cập nhật trạng thái đơn hàng
        const updateResult = await client.query(
            'UPDATE Orders SET status = $1 WHERE id = $2 RETURNING *',
            [status, id]
        );

        if (updateResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
        }

        const order = updateResult.rows[0];

        // Cập nhật trạng thái vận chuyển tương ứng
        await client.query(
            'UPDATE ShippingInfo SET shipping_status = $1, updated_at = NOW() WHERE order_id = $2',
            [status, id]
        );

        // SỬA: Lấy seller_id TRỰC TIẾP từ Orders (Vì mỗi đơn chỉ có 1 seller)
        const sellerId = order.seller_id;

        // Tạo thông báo cho Seller khi buyer xác nhận đã nhận hàng
        const notificationMessages = {
            'received': { icon: '✅', message: 'Khách hàng đã xác nhận nhận hàng' },
            'cancelled': { icon: '❌', message: 'Đơn hàng đã bị hủy' }
        };

        const notiConfig = notificationMessages[status];
        if (notiConfig && sellerId) {
            const notiResult = await client.query(
                `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                 VALUES ($1, $2, 'order_tracking', $3, $4, $5, NOW()) RETURNING *`,
                [
                    sellerId,
                    order.buyer_id,
                    `${notiConfig.icon} ${notiConfig.message}`,
                    `Đơn hàng #${id}: ${notiConfig.message}`,
                    id
                ]
            );

            // Gửi socket realtime cho seller
            sendRealtimeNotification(req, sellerId, notiResult.rows[0]);
        }

        // Gửi thông báo cho buyer
        const buyerNotiConfig = {
            'received': { icon: '✅', message: 'Bạn đã xác nhận nhận hàng thành công' },
            'cancelled': { icon: '❌', message: 'Đơn hàng đã được hủy' }
        };

        const buyerNoti = buyerNotiConfig[status];
        if (buyerNoti) {
            const notiResult = await client.query(
                `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                 VALUES ($1, NULL, 'order_tracking', $2, $3, $4, NOW()) RETURNING *`,
                [
                    order.buyer_id,
                    `${buyerNoti.icon} ${buyerNoti.message}`,
                    `Đơn hàng #${id}: ${buyerNoti.message}`,
                    id
                ]
            );

            sendRealtimeNotification(req, order.buyer_id, notiResult.rows[0]);
        }

        await client.query('COMMIT');

        res.json({ 
            success: true, 
            message: 'Cập nhật trạng thái đơn hàng thành công',
            order: order,
            orderId: id,
            newStatus: status
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error updating order status:', error);
        res.status(500).json({ message: 'Lỗi server khi cập nhật trạng thái', detail: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;
