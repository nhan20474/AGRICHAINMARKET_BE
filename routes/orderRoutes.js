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

// NEW: helper để tính trạng thái đơn hàng từ mảng trạng thái sản phẩm
const computeOrderStatus = (statuses = []) => {
	// Normalize: chuyển về lowercase, trim, loại null/undefined
	const normalized = (Array.isArray(statuses) ? statuses : [])
		.map(s => (s || '').toString().trim().toLowerCase())
		.filter(s => s !== '');

	// Nếu rỗng => pending
	if (normalized.length === 0) return 'pending';

	// Nếu có bất kỳ cancelled => ưu tiên cancelled
	if (normalized.some(s => s === 'cancelled')) return 'cancelled';

	// Loại bỏ cancelled để đánh giá tiến độ (đã xử lý ở trên)
	const nonCancelled = normalized.filter(s => s !== 'cancelled');

	// Nếu chỉ có nonCancelled = ['pending'] => coi là processing (đồng bộ với shippingRoutes)
	if (nonCancelled.length > 0 && nonCancelled.every(s => s === 'pending')) {
		return 'processing';
	}

	const priority = {
		'received': 5,
		'delivered': 4,
		'shipped': 3,
		'processing': 2,
		'pending': 1
	};

	let max = -Infinity;
	for (const s of nonCancelled) {
		const v = (typeof priority[s] === 'number') ? priority[s] : priority['pending'];
		if (v > max) max = v;
	}
	const status = Object.keys(priority).find(k => priority[k] === max) || 'pending';

	console.log('computeOrderStatus -> normalized:', normalized, 'nonCancelled:', nonCancelled, 'result:', status);
	return status;
};

// ============================================================
// 1. TẠO ĐƠN HÀNG MỚI (TÁCH THEO SELLER) - TÍCH HỢP MOMO
// ============================================================
router.post('/:userId', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { shipping_address, payment_method } = req.body;
        const userId = req.params.userId;

        console.log('📦 Đang tạo đơn hàng với payment_method:', payment_method);

        // 1. Lấy giỏ hàng KÈM THEO seller_id
        const cartRes = await client.query(
            `SELECT c.product_id, SUM(c.quantity) as quantity, p.seller_id
             FROM CartItems c
             JOIN Products p ON c.product_id = p.id
             WHERE c.user_id = $1 
             GROUP BY c.product_id, p.seller_id`,
            [userId]
        );
        
        if (cartRes.rows.length === 0) {
            throw new Error('Giỏ hàng trống, không thể tạo đơn hàng.');
        }

        // 2. NHÓM SẢN PHẨM THEO SELLER
        const groupedBySeller = {};
        
        for (const item of cartRes.rows) {
            const sellerId = item.seller_id;
            if (!groupedBySeller[sellerId]) {
                groupedBySeller[sellerId] = [];
            }
            groupedBySeller[sellerId].push(item);
        }

        console.log(`🛒 Giỏ hàng có sản phẩm từ ${Object.keys(groupedBySeller).length} farmer khác nhau`);

        const createdOrders = []; // Lưu các đơn hàng đã tạo

        // 3. TẠO TỪNG ĐƠN HÀNG CHO MỖI SELLER
        for (const [sellerId, items] of Object.entries(groupedBySeller)) {
            let totalAmount = 0;
            const notificationsToSend = [];

            // 3a. Kiểm tra tồn kho và tính tổng tiền
            for (const item of items) {
                const productRes = await client.query(
                    `SELECT id, name, price, quantity, status, unit FROM Products WHERE id = $1 FOR UPDATE`, 
                    [item.product_id]
                );
                const product = productRes.rows[0];

                if (!product) throw new Error(`Sản phẩm ID ${item.product_id} không tồn tại.`);
                
                if (product.quantity < item.quantity) {
                    throw new Error(`Sản phẩm "${product.name}" không đủ hàng (Còn: ${product.quantity}, Mua: ${item.quantity}).`);
                }
                if (product.status !== 'available') {
                    throw new Error(`Sản phẩm "${product.name}" hiện đang tạm ngừng bán.`);
                }

                totalAmount += Number(product.price) * item.quantity;
            }

            // 3b. Tạo đơn hàng
            const orderRes = await client.query(
                `INSERT INTO Orders (buyer_id, seller_id, total_amount, shipping_address, status, created_at)
                 VALUES ($1, $2, $3, $4, 'pending', NOW())
                 RETURNING id`,
                [userId, sellerId, totalAmount, shipping_address]
            );
            const orderId = orderRes.rows[0].id;

            // 3c. Xử lý từng sản phẩm
            for (const item of items) {
                const productRes = await client.query('SELECT * FROM Products WHERE id = $1', [item.product_id]);
                const product = productRes.rows[0];

                // SỬA: Lưu vào OrderItems KÈM THEO tên và ảnh sản phẩm
                await client.query(
                    `INSERT INTO OrderItems (order_id, product_id, quantity, price_per_item, product_name, product_image_url)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [orderId, item.product_id, item.quantity, product.price, product.name, product.image_url]
                );

                // Trừ tồn kho
                const newQuantity = product.quantity - item.quantity;
                let newStatus = 'available';
                if (newQuantity <= 0) newStatus = 'out_of_stock';

                await client.query(
                    `UPDATE Products SET quantity = $1, status = $2, updated_at = NOW() WHERE id = $3`,
                    [newQuantity, newStatus, item.product_id]
                );

                // Tạo ShippingInfo cho từng sản phẩm
                await client.query(
                    `INSERT INTO ShippingInfo (order_id, product_id, shipping_status, updated_at)
                     VALUES ($1, $2, 'pending', NOW())`,
                    [orderId, item.product_id]
                );

                // Thông báo cho Seller
                notificationsToSend.push({
                    user_id: product.seller_id,
                    sender_id: null,
                    type: 'order_tracking',
                    title: '📦 Đơn hàng mới',
                    message: `Bạn có đơn hàng mới #${orderId}. Sản phẩm: ${product.name} (x${item.quantity}).`,
                    product_id: product.id,
                    order_id: orderId
                });

                // Cảnh báo sắp hết hàng
                if (newQuantity <= 10) {
                    notificationsToSend.push({
                        user_id: product.seller_id,
                        sender_id: null,
                        type: 'inventory_warning',
                        title: '⚠️ Cảnh báo sắp hết hàng',
                        message: `Sản phẩm "${product.name}" chỉ còn ${newQuantity} ${product.unit || 'đv'}. Vui lòng nhập thêm.`,
                        product_id: product.id
                    });
                }
            }

            // 3d. Tạo payment record
            let payment_status = 'pending';
            let transaction_id = null;

            if (payment_method === 'cod') {
                payment_status = 'paid';
                transaction_id = `COD-${orderId}-${Date.now()}`;
            } else if (payment_method === 'momo') {
                payment_status = 'pending';
                transaction_id = `MOMO_PENDING_${orderId}`;
            }

            await client.query(
                `INSERT INTO Payments (order_id, payment_method, payment_status, amount, transaction_id, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())`,
                [orderId, payment_method || 'cod', payment_status, totalAmount, transaction_id]
            );

            // 3e. Lưu thông báo
            for (const noti of notificationsToSend) {
                const res = await client.query(
                    `INSERT INTO Notifications (user_id, sender_id, type, title, message, product_id, order_id, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
                    [noti.user_id, noti.sender_id, noti.type, noti.title, noti.message, noti.product_id || null, noti.order_id || null]
                );
                sendRealtimeNotification(req, noti.user_id, res.rows[0]);
            }

            createdOrders.push({
                order_id: orderId,
                seller_id: sellerId,
                total_amount: totalAmount
            });
        }

        // 4. Xóa giỏ hàng
        await client.query('DELETE FROM CartItems WHERE user_id = $1', [userId]);

        // 5. Thông báo cho Admin & Buyer
        const adminNoti = await client.query(
            `INSERT INTO Notifications (user_id, sender_id, type, title, message, created_at)
             VALUES (1, NULL, 'system', '💰 Đơn hàng mới', $1, NOW()) RETURNING *`,
            [`Người dùng #${userId} vừa đặt ${createdOrders.length} đơn hàng từ ${createdOrders.length} farmer khác nhau.`]
        );
        sendRealtimeNotification(req, 1, adminNoti.rows[0]);

        const buyerNoti = await client.query(
            `INSERT INTO Notifications (user_id, sender_id, type, title, message, created_at)
             VALUES ($1, NULL, 'order_tracking', '✅ Đặt hàng thành công', $2, NOW()) RETURNING *`,
            [parseInt(userId), `Đơn hàng của bạn đã được tạo (${createdOrders.length} đơn). ${payment_method === 'momo' ? 'Vui lòng thanh toán.' : ''}`]
        );
        sendRealtimeNotification(req, parseInt(userId), buyerNoti.rows[0]);

        await client.query('COMMIT');

        // ✅ SỬA: Trả về cả order_id đầu tiên (để frontend dễ xử lý) và order_ids (mảng đầy đủ)
        res.status(201).json({ 
            success: true,
            message: 'Đặt hàng thành công', 
            orders: createdOrders,
            order_id: createdOrders[0]?.order_id, // ✅ THÊM: order_id đầu tiên
            order_ids: createdOrders.map(o => o.order_id), // ✅ Mảng tất cả order_id
            total_orders: createdOrders.length, // ✅ Số lượng đơn hàng
            payment_method: payment_method || 'cod'
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Order Error:', err);
        res.status(500).json({ error: err.message || 'Lỗi tạo đơn hàng' });
    } finally {
        client.release();
    }
});

// ============================================================
// CẬP NHẬT: API mới - Farmer cập nhật trạng thái sản phẩm CỦA MÌNH
// ============================================================
router.put('/:orderId/product/:productId/status', async (req, res) => {
	const { status, seller_id } = req.body;
	const { orderId, productId } = req.params;

	// Normalize incoming status early to avoid undefined / case issues
	const statusNorm = (typeof status === 'undefined' || status === null) ? null : String(status).trim().toLowerCase();
	console.log('📥 PUT /:orderId/product/:productId/status called with body:', req.body, 'normalized status:', statusNorm);

	// Validate presence của status (tránh undefined như log trước)
	if (!statusNorm) {
		return res.status(400).json({ error: 'Thiếu trường status trong body' });
	}
	const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'received'];
	if (!validStatuses.includes(statusNorm)) {
		return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		// 1. Kiểm tra quyền
        const productCheck = await client.query(
            `SELECT p.seller_id, p.name, o.buyer_id 
             FROM Products p
             JOIN OrderItems oi ON p.id = oi.product_id
             JOIN Orders o ON oi.order_id = o.id
             WHERE o.id = $1 AND p.id = $2`,
            [orderId, productId]
        );

        if (productCheck.rows.length === 0) {
            throw new Error('Không tìm thấy sản phẩm trong đơn hàng này');
        }

        const product = productCheck.rows[0];
        
        if (parseInt(product.seller_id) !== parseInt(seller_id)) {
            throw new Error('Bạn không có quyền cập nhật sản phẩm này');
        }

        // 2. Cập nhật ShippingInfo cho sản phẩm CỤ THỂ (dùng statusNorm)
        const result = await client.query(
            `UPDATE ShippingInfo 
             SET shipping_status = $1, updated_at = NOW()
             WHERE order_id = $2 AND product_id = $3
             RETURNING *`,
            [statusNorm, orderId, productId]
        );

        if (result.rows.length === 0) {
            throw new Error('Không tìm thấy thông tin vận chuyển');
        }

        // 3) Tính trạng thái đơn hàng tổng thể sử dụng helper (lấy và normalize bên trong helper)
        const allProducts = await client.query(
            `SELECT shipping_status FROM ShippingInfo WHERE order_id = $1`,
            [orderId]
        );
        const allStatuses = allProducts.rows.map(r => r.shipping_status);
        console.log('📦 Trạng thái các sản phẩm (raw):', allStatuses);

        const orderStatus = computeOrderStatus(allStatuses);

        // 4) Cập nhật Orders.status
        await client.query(`UPDATE Orders SET status = $1 WHERE id = $2`, [orderStatus, orderId]);

        console.log(`✅ Order #${orderId} → Status mới: ${orderStatus}`);

        // 5) Thông báo cho buyer (và giữ seller nếu cần)
        const notificationMessages = {
            'pending': `⏳ Sản phẩm đang chờ xử lý`,
            'processing': `📦 Sản phẩm đang được chuẩn bị`,
            'shipped': `🚚 Sản phẩm đã được gửi đi`,
            'delivered': `📍 Sản phẩm đã được giao`,
            'cancelled': `❌ Sản phẩm đã bị hủy`,
            'received': `✅ Khách đã nhận hàng`
        };

        // Lấy lại thông tin buyer/seller/product để thông báo (giữ an toàn nếu null)
        const prodInfoRes = await client.query(
            `SELECT p.name, o.buyer_id FROM OrderItems oi
			 JOIN Products p ON oi.product_id = p.id
			 JOIN Orders o ON oi.order_id = o.id
			 WHERE o.id = $1 AND oi.product_id = $2 LIMIT 1`,
            [orderId, productId]
        );
        const prodInfo = prodInfoRes.rows[0] || {};
        const buyerId = prodInfo.buyer_id || null;
        const productName = prodInfo.name || (`Sản phẩm #${productId}`);

        if (buyerId) {
            const notiResult = await client.query(
                `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, product_id, created_at)
				 VALUES ($1, $2, 'order_tracking', $3, $4, $5, $6, NOW()) RETURNING *`,
                [
					buyerId,
					seller_id || null,
					`Đơn hàng #${orderId}: ${notificationMessages[statusNorm] || 'Cập nhật trạng thái'}`,
					notificationMessages[statusNorm] ? `${notificationMessages[statusNorm].replace('Sản phẩm', `"${productName}"`)}` : 'Cập nhật trạng thái',
					orderId,
					productId
                ]
            );
            sendRealtimeNotification(req, buyerId, notiResult.rows[0]);
        }

		await client.query('COMMIT');
		res.json({
			message: 'Cập nhật trạng thái thành công',
			shipping_info: result.rows[0],
			order_status: orderStatus
		});
	} catch (err) {
		await client.query('ROLLBACK');
		console.error('Update Status Error:', err);
		res.status(500).json({ error: err.message || 'Lỗi cập nhật trạng thái' });
	} finally {
		client.release();
	}
});

// ============================================================
// GIỮ NGUYÊN: API cũ cho Buyer xác nhận đã nhận hàng
// ============================================================
router.put('/:orderId/status', async (req, res) => {
    const { status, buyer_id } = req.body;
    const { orderId } = req.params;

    console.log('📥 PUT /:orderId/status called with:', { orderId, status, buyer_id });

    // CHỈ CHO PHÉP buyer xác nhận 'received' hoặc 'cancelled'
    const validStatuses = ['received', 'cancelled'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Chỉ được xác nhận nhận hàng hoặc hủy đơn' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lấy thông tin đơn hàng trước
        const orderCheck = await client.query(
            `SELECT buyer_id, seller_id FROM Orders WHERE id = $1`,
            [orderId]
        );

        if (orderCheck.rows.length === 0) {
            throw new Error('Không tìm thấy đơn hàng');
        }

        const order = orderCheck.rows[0];
        
        // SỬA: Chỉ kiểm tra quyền NẾU frontend gửi buyer_id
        // Nếu không gửi thì tin tưởng orderId (vì buyer chỉ thấy đơn của mình)
        if (buyer_id && parseInt(buyer_id) !== parseInt(order.buyer_id)) {
            throw new Error('Bạn không có quyền xác nhận đơn hàng này');
        }

        // Cập nhật trạng thái đơn hàng
        const result = await client.query(
            `UPDATE Orders SET status = $1 WHERE id = $2 RETURNING *`,
            [status, orderId]
        );

        // Đồng bộ ShippingInfo cho TẤT CẢ sản phẩm trong đơn
        await client.query(
            `UPDATE ShippingInfo 
             SET shipping_status = $1, updated_at = NOW()
             WHERE order_id = $2`,
            [status, orderId]
        );

        // Gửi thông báo cho seller
        const sellerNotify = await client.query(
            `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
             VALUES ($1, $2, 'order_tracking', $3, $4, $5, NOW()) RETURNING *`,
            [
                order.seller_id,
                order.buyer_id,
                status === 'received' ? '✅ Khách đã nhận hàng' : '❌ Đơn hàng bị hủy',
                `Đơn hàng #${orderId}: ${status === 'received' ? 'Đã hoàn thành' : 'Đã bị hủy'}`,
                orderId
            ]
        );

        sendRealtimeNotification(req, order.seller_id, sellerNotify.rows[0]);

        await client.query('COMMIT');
        
        console.log('✅ Order status updated successfully:', result.rows[0]);
        
        res.json({ 
            success: true,
            message: 'Cập nhật trạng thái thành công', 
            order: result.rows[0] 
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Update Status Error:', err);
        res.status(500).json({ 
            success: false,
            error: err.message || 'Lỗi cập nhật trạng thái' 
        });
    } finally {
        client.release();
    }
});

// ============================================================
// 2. CÁC API GET (LẤY DỮ LIỆU) - GIỮ NGUYÊN LOGIC CŨ
// ============================================================

// Lấy danh sách đơn hàng của user
router.get('/:userId', async (req, res) => {
    try {
        console.log('🔍 GET /:userId được gọi với userId:', req.params.userId);
        
        const orders = await pool.query(
            `SELECT o.*, u.full_name as seller_name, u.phone_number as seller_phone
             FROM Orders o
             LEFT JOIN Users u ON o.seller_id = u.id
             WHERE o.buyer_id = $1 
             ORDER BY o.created_at DESC`,
            [req.params.userId]
        );
        
        console.log(`📦 Tìm thấy ${orders.rows.length} đơn hàng`);
        
        const orderList = [];
        
        for (const order of orders.rows) {
            // SỬA: Query sử dụng LEFT JOIN và COALESCE để xử lý sản phẩm đã xóa
            const items = await pool.query(
                `SELECT oi.*, 
                        COALESCE(p.name, oi.product_name, '[Sản phẩm đã bị xóa]') as name,
                        COALESCE(p.image_url, oi.product_image_url) as image_url,
                        p.seller_id, 
                        p.unit, 
                        p.description,
                        CASE WHEN p.id IS NULL THEN true ELSE false END as is_deleted
                 FROM OrderItems oi
                 LEFT JOIN Products p ON oi.product_id = p.id
                 WHERE oi.order_id = $1`,
                [order.id]
            );

            const paymentResult = await pool.query(
                `SELECT * FROM Payments WHERE order_id = $1`,
                [order.id]
            );

            const buyerResult = await pool.query(
                `SELECT id, full_name, email, phone_number, address FROM Users WHERE id = $1`,
                [order.buyer_id]
            );

            orderList.push({ 
                ...order, 
                items: items.rows,
                payment: paymentResult.rows.length > 0 ? paymentResult.rows[0] : null,
                buyer: buyerResult.rows.length > 0 ? buyerResult.rows[0] : null
            });
        }
        
        res.json(orderList);
    } catch (err) {
        console.error('❌ Lỗi lấy danh sách đơn hàng:', err);
        res.status(500).json({ error: 'Lỗi lấy danh sách đơn hàng', detail: err.message });
    }
});

// Lấy chi tiết đơn hàng
router.get('/detail/:orderId', async (req, res) => {
    try {
        const order = await pool.query('SELECT * FROM Orders WHERE id = $1', [req.params.orderId]);
        if (order.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

        const items = await pool.query(
            `SELECT oi.*, p.name, p.image_url, p.seller_id
             FROM OrderItems oi
             JOIN Products p ON oi.product_id = p.id
             WHERE oi.order_id = $1`,
            [req.params.orderId]
        );
        res.json({ order: order.rows[0], items: items.rows });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi lấy chi tiết đơn hàng', detail: err.message });
    }
});

// Xóa đơn hàng
router.delete('/:orderId', async (req, res) => {
    try {
        // Lưu ý: Khi xóa đơn, có thể cần trả lại số lượng vào kho (tùy nghiệp vụ)
        // Ở đây làm đơn giản là xóa luôn
        const result = await pool.query('DELETE FROM Orders WHERE id = $1 RETURNING *', [req.params.orderId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
        res.json({ message: 'Xóa đơn hàng thành công', order: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi xóa đơn hàng', detail: err.message });
    }
});

// Lấy lịch sử mua hàng
router.get('/history/:userId', async (req, res) => {
    try {
        const orders = await pool.query(
            `SELECT * FROM Orders WHERE buyer_id = $1 ORDER BY created_at DESC`,
            [req.params.userId]
        );
        const orderList = [];
        for (const order of orders.rows) {
            const items = await pool.query(
                `SELECT oi.*, p.name, p.image_url, p.seller_id
                 FROM OrderItems oi
                 JOIN Products p ON oi.product_id = p.id
                 WHERE oi.order_id = $1`,
                [order.id]
            );
            orderList.push({ order, items: items.rows });
        }
        res.json(orderList);
    } catch (err) {
        res.status(500).json({ error: 'Lỗi lấy lịch sử mua hàng', detail: err.message });
    }
});

// Lấy tất cả đơn hàng (Admin)
router.get('/', async (req, res) => {
    try {
        const orders = await pool.query('SELECT * FROM Orders ORDER BY created_at DESC');
        const orderList = [];
        for (const order of orders.rows) {
            const items = await pool.query(
                `SELECT oi.*, p.name, p.image_url, p.seller_id
                 FROM OrderItems oi
                 JOIN Products p ON oi.product_id = p.id
                 WHERE oi.order_id = $1`,
                [order.id]
            );
            orderList.push({ ...order, items: items.rows });
        }
        res.json(orderList);
    } catch (err) {
        res.status(500).json({ error: 'Lỗi lấy tất cả đơn hàng', detail: err.message });
    }
});

// Lấy đơn hàng theo Seller (Farmer Dashboard)
router.get('/by-seller/:sellerId', async (req, res) => {
    try {
        console.log('🔍 GET /by-seller/:sellerId được gọi với sellerId:', req.params.sellerId);
        
        // SỬA: Đơn giản hơn vì đã có seller_id trong Orders
        const orders = await pool.query(`
            SELECT * FROM Orders
            WHERE seller_id = $1
            ORDER BY created_at DESC
        `, [req.params.sellerId]);

        console.log(`📦 Tìm thấy ${orders.rows.length} đơn hàng cho seller`);

        const orderList = [];
        for (const order of orders.rows) {
            const items = await pool.query(
                `SELECT oi.*, 
                        p.name, p.image_url, p.unit, p.description
                 FROM OrderItems oi
                 JOIN Products p ON oi.product_id = p.id
                 WHERE oi.order_id = $1`,
                [order.id]
            );
            
            const paymentResult = await pool.query(
                `SELECT * FROM Payments WHERE order_id = $1`,
                [order.id]
            );

            const buyerResult = await pool.query(
                `SELECT id, full_name, email, phone_number, address FROM Users WHERE id = $1`,
                [order.buyer_id]
            );

            orderList.push({
                ...order,
                items: items.rows,
                payment: paymentResult.rows.length > 0 ? paymentResult.rows[0] : null,
                buyer: buyerResult.rows.length > 0 ? buyerResult.rows[0] : null
            });
        }
        
        res.json(orderList);
    } catch (err) {
        console.error('❌ Lỗi lấy đơn hàng của farmer:', err);
        res.status(500).json({ error: 'Lỗi lấy đơn hàng của farmer', detail: err.message });
    }
});

module.exports = router;