const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const crypto = require('crypto');
const https = require('https');
const momoConfig = require('../config/momo');
const QRCode = require('qrcode');

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

// ============================================================
// 🔥 MOMO API THẬT - TẠO PAYMENT REQUEST (FIXED)
// ============================================================
router.post('/momo/create-payment', async (req, res) => {
    // SỬA: Nhận cả order_id và orderId (tùy frontend gửi cái nào)
    const { order_id, orderId, amount: frontendAmount, orderInfo: frontendOrderInfo, total_amount } = req.body;
    // Lấy order_id (ưu tiên order_id, fallback sang orderId)
    const realOrderId = order_id || orderId;

    console.log('📥 Request từ frontend:', { 
        order_id, 
        orderId, 
        frontendAmount, 
        frontendOrderInfo,
        realOrderId 
    });

    // Validation chặt chẽ hơn
    if (!realOrderId || isNaN(Number(realOrderId))) {
        return res.status(400).json({ 
            error: 'Thiếu hoặc sai order_id/orderId',
            received: { order_id, orderId },
            hint: 'Frontend phải gửi { order_id: 123 } hoặc { orderId: 123 } (số hợp lệ)'
        });
    }
    if (typeof total_amount === 'undefined' || isNaN(Number(total_amount)) || Number(total_amount) < 1000 || Number(total_amount) > 50000000) {
        return res.status(400).json({
            error: 'Số tiền thanh toán không hợp lệ',
            received: { total_amount },
            hint: 'total_amount phải là số từ 1,000 đến 50,000,000 VNĐ'
        });
    }

    try {
        // Lấy thông tin đơn hàng từ DB
        const orderResult = await pool.query(
            `SELECT o.id, o.buyer_id, o.total_amount, o.seller_id, o.status
             FROM Orders o
             WHERE o.id = $1`,
            [realOrderId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ 
                error: 'Không tìm thấy đơn hàng',
                order_id: realOrderId 
            });
        }

        const order = orderResult.rows[0];

        // Kiểm tra trạng thái đơn hàng
        if (order.status === 'cancelled') {
            return res.status(400).json({ error: 'Đơn hàng đã bị hủy, không thể thanh toán' });
        }

        // SỬA: Lấy amount từ req.body.total_amount nếu có, ưu tiên FE gửi lên, fallback sang DB
        let amount;
        if (typeof total_amount !== 'undefined' && !isNaN(Number(total_amount))) {
            amount = Math.round(Number(total_amount)).toString();
        } else {
            amount = Math.round(parseFloat(order.total_amount)).toString();
        }

        console.log('📦 Order info:', {
            order_id: order.id,
            buyer_id: order.buyer_id,
            amount: amount,
            status: order.status
        });

        // Kiểm tra amount hợp lệ
        if (parseInt(amount) < 1000 || parseInt(amount) > 50000000) {
            return res.status(400).json({ 
                error: 'Số tiền không hợp lệ',
                amount: amount,
                range: '1,000 - 50,000,000 VNĐ'
            });
        }

        // Tạo các tham số theo format MOMO
        const requestId = momoConfig.partnerCode + new Date().getTime();
        const orderId = requestId;
        const orderInfo = `Thanh toan don hang #${order.id}`;
        const extraData = '';
        
        // Tạo rawSignature theo đúng format MOMO
        const rawSignature = 
            "accessKey=" + momoConfig.accessKey +
            "&amount=" + amount +
            "&extraData=" + extraData +
            "&ipnUrl=" + momoConfig.ipnUrl +
            "&orderId=" + orderId +
            "&orderInfo=" + orderInfo +
            "&partnerCode=" + momoConfig.partnerCode +
            "&redirectUrl=" + momoConfig.redirectUrl +
            "&requestId=" + requestId +
            "&requestType=" + momoConfig.requestType;

        console.log("--------------------RAW SIGNATURE----------------");
        console.log(rawSignature);

        // Tạo signature
        const signature = crypto
            .createHmac('sha256', momoConfig.secretKey)
            .update(rawSignature)
            .digest('hex');

        console.log("--------------------SIGNATURE----------------");
        console.log(signature);

        // Request body gửi đến MOMO
        const requestBody = JSON.stringify({
            partnerCode: momoConfig.partnerCode,
            accessKey: momoConfig.accessKey,
            requestId: requestId,
            amount: amount,
            orderId: orderId,
            orderInfo: orderInfo,
            redirectUrl: momoConfig.redirectUrl,
            ipnUrl: momoConfig.ipnUrl,
            extraData: extraData,
            requestType: momoConfig.requestType,
            signature: signature,
            lang: 'vi'
        });

        console.log('📤 MOMO Request:', requestBody);

        // Lưu thông tin payment vào DB trước (UPSERT)
        await pool.query(
            `INSERT INTO Payments (order_id, payment_method, payment_status, amount, transaction_id, created_at)
             VALUES ($1, 'momo', 'pending', $2, $3, NOW())
             ON CONFLICT (order_id) DO UPDATE SET 
                payment_status = 'pending',
                transaction_id = $3,
                amount = $2`,
            [order.id, amount, orderId]
        );

        // Gửi request đến MOMO qua HTTPS
        const options = {
            hostname: momoConfig.endpoint.hostname,
            port: momoConfig.endpoint.port,
            path: momoConfig.endpoint.path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const momoRequest = https.request(options, (momoResponse) => {
            console.log(`📥 MOMO Status: ${momoResponse.statusCode}`);
            
            let responseData = '';
            
            momoResponse.setEncoding('utf8');
            momoResponse.on('data', (chunk) => {
                responseData += chunk;
            });

            momoResponse.on('end', () => {
                console.log('📥 MOMO Response Body:', responseData);
                
                try {
                    const result = JSON.parse(responseData);
                    
                    if (result.resultCode === 0) {
                        res.json({
                            success: true,
                            message: 'Tạo payment request thành công',
                            payUrl: result.payUrl,
                            deeplink: result.deeplink,
                            qrCodeUrl: result.qrCodeUrl,
                            order_id: order.id,
                            amount: amount,
                            requestId: requestId
                        });
                    } else {
                        res.status(400).json({
                            success: false,
                            error: 'MOMO trả về lỗi',
                            resultCode: result.resultCode,
                            message: result.message || result.localMessage,
                            detail: result
                        });
                    }
                } catch (parseError) {
                    console.error('❌ Parse error:', parseError);
                    res.status(500).json({ 
                        error: 'Lỗi parse response từ MOMO',
                        detail: parseError.message,
                        raw: responseData
                    });
                }
            });
        });

        momoRequest.on('error', (error) => {
            console.error('❌ MOMO Request Error:', error);
            res.status(500).json({ 
                error: 'Lỗi kết nối đến MOMO', 
                detail: error.message 
            });
        });

        console.log("Sending to MOMO....");
        momoRequest.write(requestBody);
        momoRequest.end();

    } catch (error) {
        console.error('❌ Server Error:', error);
        res.status(500).json({ 
            error: 'Lỗi tạo payment request', 
            detail: error.message 
        });
    }
});

// ============================================================
// 🔥 MOMO CALLBACK (IPN) - Webhook từ MOMO
// ============================================================
router.post('/momo/callback', async (req, res) => {
    console.log('🔔 MOMO Callback received:', req.body);

    const {
        partnerCode,
        orderId,
        requestId,
        amount,
        orderInfo,
        orderType,
        transId,
        resultCode,
        message,
        payType,
        responseTime,
        extraData,
        signature
    } = req.body;

    // Xác thực chữ ký từ MOMO
    const rawSignature = 
        "accessKey=" + momoConfig.accessKey +
        "&amount=" + amount +
        "&extraData=" + extraData +
        "&message=" + message +
        "&orderId=" + orderId +
        "&orderInfo=" + orderInfo +
        "&orderType=" + orderType +
        "&partnerCode=" + partnerCode +
        "&payType=" + payType +
        "&requestId=" + requestId +
        "&responseTime=" + responseTime +
        "&resultCode=" + resultCode +
        "&transId=" + transId;

    const expectedSignature = crypto
        .createHmac('sha256', momoConfig.secretKey)
        .update(rawSignature)
        .digest('hex');

    if (signature !== expectedSignature) {
        console.error('❌ Invalid signature from MOMO');
        console.log('Expected:', expectedSignature);
        console.log('Received:', signature);
        return res.status(403).json({ error: 'Invalid signature' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Tìm order_id gốc từ transaction_id
        const paymentResult = await client.query(
            `SELECT order_id FROM Payments WHERE transaction_id = $1`,
            [orderId]
        );

        if (paymentResult.rows.length === 0) {
            console.error('❌ Payment not found for orderId:', orderId);
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Payment not found' });
        }

        const realOrderId = paymentResult.rows[0].order_id;

        if (resultCode === 0) {
            // Thanh toán thành công
            await client.query(
                `UPDATE Payments 
                 SET payment_status = 'paid', 
                     paid_at = NOW(),
                     transaction_id = $1
                 WHERE order_id = $2`,
                [transId.toString(), realOrderId]
            );

            // Lấy buyer_id để gửi thông báo
            const orderResult = await client.query(
                `SELECT buyer_id FROM Orders WHERE id = $1`,
                [realOrderId]
            );

            if (orderResult.rows.length > 0) {
                const buyer_id = orderResult.rows[0].buyer_id;

                // Tạo thông báo
                const notiResult = await client.query(
                    `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                     VALUES ($1, NULL, 'payment', '✅ Thanh toán thành công', $2, $3, NOW()) RETURNING *`,
                    [buyer_id, `Đơn hàng #${realOrderId} đã được thanh toán qua MOMO. Mã GD: ${transId}`, realOrderId]
                );

                // Gửi socket realtime
                sendRealtimeNotification(req, buyer_id, notiResult.rows[0]);
            }

            console.log('✅ Payment success for order:', realOrderId);
        } else {
            // Thanh toán thất bại
            await client.query(
                `UPDATE Payments 
                 SET payment_status = 'failed'
                 WHERE order_id = $1`,
                [realOrderId]
            );

            console.log('❌ Payment failed for order:', realOrderId, 'Message:', message);
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'OK' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Callback processing error:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// ============================================================
// ✅ KIỂM TRA TRẠNG THÁI THANH TOÁN
// ============================================================
router.get('/status/:orderId', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT 
                p.id,
                p.order_id,
                p.payment_method,
                p.payment_status,
                p.amount,
                p.transaction_id,
                p.paid_at,
                p.created_at,
                o.buyer_id,
                o.total_amount,
                o.status as order_status
             FROM Payments p
             JOIN Orders o ON p.order_id = o.id
             WHERE p.order_id = $1`,
            [req.params.orderId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                isPaid: false,
                message: 'Chưa có thông tin thanh toán',
                payment: null 
            });
        }

        const payment = result.rows[0];
        
        res.json({
            success: true,
            isPaid: payment.payment_status === 'paid',
            payment_status: payment.payment_status,
            payment_method: payment.payment_method,
            amount: payment.amount,
            transaction_id: payment.transaction_id,
            paid_at: payment.paid_at,
            order_status: payment.order_status,
            payment: payment
        });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi kiểm tra trạng thái', detail: err.message });
    }
});

// ✅ POLLING API - FE gọi liên tục để check
router.post('/check-payment-status', async (req, res) => {
    const { order_id } = req.body;
    
    try {
        const result = await pool.query(
            `SELECT payment_status, paid_at, transaction_id 
             FROM Payments 
             WHERE order_id = $1`,
            [order_id]
        );

        if (result.rows.length === 0) {
            return res.json({
                isPaid: false,
                payment_status: 'not_found',
                message: 'Chưa có thông tin thanh toán'
            });
        }

        const payment = result.rows[0];
        
        res.json({
            isPaid: payment.payment_status === 'paid',
            payment_status: payment.payment_status,
            transaction_id: payment.transaction_id,
            paid_at: payment.paid_at
        });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi kiểm tra', detail: err.message });
    }
});

// ============================================================
// ✅ API VERIFY THANH TOÁN - FE gọi sau khi user thanh toán
// ============================================================
router.post('/momo/verify', async (req, res) => {
    const { order_id } = req.body; // ✅ Nhận order_id (đơn giản hơn cho FE)
    
    if (!order_id) {
        return res.status(400).json({ error: 'Thiếu order_id' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Tìm payment theo order_id (không phải requestId)
        const paymentResult = await client.query(
            `SELECT p.*, o.buyer_id 
             FROM Payments p
             JOIN Orders o ON p.order_id = o.id
             WHERE p.order_id = $1`,
            [order_id]
        );

        if (paymentResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                error: 'Không tìm thấy thông tin thanh toán',
                isPaid: false 
            });
        }

        const payment = paymentResult.rows[0];
        const buyer_id = payment.buyer_id;

        // 2. Nếu đã paid rồi thì trả về luôn
        if (payment.payment_status === 'paid') {
            await client.query('COMMIT');
            return res.json({
                success: true,
                isPaid: true,
                order_id: order_id,
                message: 'Đơn hàng đã được thanh toán',
                payment: payment
            });
        }

        // 3. Lấy requestId từ transaction_id để query MOMO
        const requestId = payment.transaction_id;
        
        const rawSignature = 
            "accessKey=" + momoConfig.accessKey +
            "&orderId=" + requestId +
            "&partnerCode=" + momoConfig.partnerCode +
            "&requestId=" + requestId;

        const signature = crypto
            .createHmac('sha256', momoConfig.secretKey)
            .update(rawSignature)
            .digest('hex');

        const queryBody = JSON.stringify({
            partnerCode: momoConfig.partnerCode,
            requestId: requestId,
            orderId: requestId,
            signature: signature,
            lang: 'vi'
        });

        console.log('🔍 Querying MOMO with requestId:', requestId);

        // Gọi MOMO query API
        const queryOptions = {
            hostname: momoConfig.endpoint.hostname,
            port: momoConfig.endpoint.port,
            path: '/v2/gateway/api/query',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(queryBody)
            }
        };

        const queryPromise = new Promise((resolve, reject) => {
            const queryRequest = https.request(queryOptions, (momoResponse) => {
                let responseData = '';
                momoResponse.on('data', (chunk) => { responseData += chunk; });
                momoResponse.on('end', () => {
                    try {
                        resolve(JSON.parse(responseData));
                    } catch (err) {
                        reject(err);
                    }
                });
            });
            queryRequest.on('error', reject);
            queryRequest.write(queryBody);
            queryRequest.end();
        });

        const momoResult = await queryPromise;

        console.log('📥 MOMO Query Result:', momoResult);

        // 4. Xử lý kết quả từ MOMO
        if (momoResult.resultCode === 0) {
            // Thanh toán thành công → Update DB
            await client.query(
                `UPDATE Payments 
                 SET payment_status = 'paid', 
                     paid_at = NOW(),
                     transaction_id = $1
                 WHERE order_id = $2`,
                [momoResult.transId.toString(), order_id]
            );

            // Tạo thông báo
            const notiResult = await client.query(
                `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                 VALUES ($1, NULL, 'payment', '✅ Thanh toán thành công', $2, $3, NOW()) RETURNING *`,
                [buyer_id, `Đơn hàng #${order_id} đã được thanh toán qua MOMO. Mã GD: ${momoResult.transId}`, order_id]
            );

            // Gửi socket realtime
            sendRealtimeNotification(req, buyer_id, notiResult.rows[0]);

            await client.query('COMMIT');

            res.json({
                success: true,
                isPaid: true,
                order_id: order_id,
                message: 'Thanh toán thành công',
                transaction_id: momoResult.transId,
                payment_method: 'momo'
            });

        } else if (momoResult.resultCode === 1000) {
            // Giao dịch đang chờ xử lý
            await client.query('COMMIT');
            res.json({
                success: false,
                isPaid: false,
                order_id: order_id,
                message: 'Giao dịch đang chờ xử lý',
                payment_status: 'pending'
            });

        } else {
            // Thanh toán thất bại
            await client.query(
                `UPDATE Payments SET payment_status = 'failed' WHERE order_id = $1`,
                [order_id]
            );

            await client.query('COMMIT');

            res.json({
                success: false,
                isPaid: false,
                order_id: order_id,
                message: momoResult.message || 'Thanh toán thất bại',
                resultCode: momoResult.resultCode
            });
        }

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Verify Error:', error);
        res.status(500).json({ 
            error: 'Lỗi xác thực thanh toán', 
            detail: error.message 
        });
    } finally {
        client.release();
    }
});

module.exports = router;