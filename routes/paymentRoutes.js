const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const crypto = require('crypto');
const https = require('https');
const momoConfig = require('../config/momo');
const vnpayConfig = require('../config/vnpay');
// removed unused imports: querystring, qrcode

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
    const src = Object.assign({}, req.query || {}, req.params || {}, req.body || {});
    const { order_id, orderId, amount: frontendAmount, orderInfo: frontendOrderInfo, total_amount } = src;
    // Lấy order_id (ưu tiên body/query/params order_id, fallback sang orderId)
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
        const momoOrderId = requestId;
        const orderInfo = `Thanh toan don hang #${order.id}`;
        const extraData = '';
        
        // Tạo rawSignature theo đúng format MOMO
        const rawSignature = 
            "accessKey=" + momoConfig.accessKey +
            "&amount=" + amount +
            "&extraData=" + extraData +
            "&ipnUrl=" + momoConfig.ipnUrl +
            "&orderId=" + momoOrderId +
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
            orderId: momoOrderId,
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
            [order.id, amount, momoOrderId]
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
// 🔥 VNPAY - TẠO PAYMENT URL, RETURN & IPN
// ============================================================
router.post('/vnpay/create-payment', async (req, res) => {
    const src = Object.assign({}, req.query || {}, req.params || {}, req.body || {});
    const { order_id, orderId, total_amount } = src;
    const realOrderId = order_id || orderId;

    if (!realOrderId || isNaN(Number(realOrderId))) {
        return res.status(400).json({ error: 'Thiếu hoặc sai order_id' });
    }

    try {
        const orderResult = await pool.query(
            `SELECT id, buyer_id, total_amount, status FROM Orders WHERE id = $1`,
            [realOrderId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
        }

        const order = orderResult.rows[0];
        if (order.status === 'cancelled') return res.status(400).json({ error: 'Đơn hàng đã bị hủy' });

        let amount = typeof total_amount !== 'undefined' && !isNaN(Number(total_amount)) ? Math.round(Number(total_amount)) : Math.round(parseFloat(order.total_amount));

        if (amount < 1000 || amount > 50000000) {
            return res.status(400).json({ error: 'Số tiền không hợp lệ' });
        }

        // VNPay expects amount in smallest unit (multiply by 100)
        const vnpAmount = (amount * 100).toString();
        const tmnCode = vnpayConfig.vnp_TmnCode;
        const secretKey = vnpayConfig.vnp_HashSecret;
        const vnpUrl = vnpayConfig.vnp_Url;
        const returnUrl = vnpayConfig.vnp_ReturnUrl;

        const createDate = new Date();
        const pad = (n) => n.toString().padStart(2, '0');
        const formatDate = `${createDate.getFullYear()}${pad(createDate.getMonth()+1)}${pad(createDate.getDate())}${pad(createDate.getHours())}${pad(createDate.getMinutes())}${pad(createDate.getSeconds())}`;

        const txnRef = tmnCode + Date.now();
        const orderInfo = `Thanh toan don hang #${order.id}`;

        const vnp_Params = {
            vnp_Version: vnpayConfig.vnp_Version,
            vnp_Command: vnpayConfig.vnp_Command,
            vnp_TmnCode: tmnCode,
            vnp_Amount: vnpAmount,
            vnp_CurrCode: vnpayConfig.vnp_CurrCode,
            vnp_TxnRef: txnRef,
            vnp_OrderInfo: orderInfo,
            vnp_OrderType: 'other',
            vnp_Locale: 'vi',
            vnp_ReturnUrl: returnUrl,
            vnp_CreateDate: formatDate,
            vnp_IpAddr: req.ip || vnpayConfig.vnp_IpAddr
        };

        // Sort and build sign data
        const sortedKeys = Object.keys(vnp_Params).sort();
        // build raw and encoded forms
        const rawSignData = sortedKeys.map(key => `${key}=${vnp_Params[key]}`).join('&'); // reference
        const encodedSignData = sortedKeys.map(key => `${key}=${encodeURIComponent(vnp_Params[key])}`).join('&');
        const encodedPlusSignData = encodedSignData.replace(/%20/g, '+'); // variant many gateways use
        const queryString = encodedSignData; // default query uses encoded values

        // compute candidate hashes
        const hashEncoded = crypto.createHmac('sha512', secretKey).update(encodedSignData).digest('hex');
        const hashEncodedPlus = crypto.createHmac('sha512', secretKey).update(encodedPlusSignData).digest('hex');
        const hashRaw = crypto.createHmac('sha512', secretKey).update(rawSignData).digest('hex');

        // DEBUG: log candidates
        console.log('🔐 VNPay rawSignData:', rawSignData);
        console.log('🔐 VNPay encodedSignData:', encodedSignData);
        console.log('🔐 VNPay encodedPlusSignData:', encodedPlusSignData);
        console.log('🧾 VNPay hashEncoded:', hashEncoded);
        console.log('🧾 VNPay hashEncodedPlus:', hashEncodedPlus);
        console.log('🧾 VNPay hashRaw:', hashRaw);

        // Prefer encodedPlus variant for URL (more compatible), fallback to encoded
        const vnp_SecureHash = hashEncodedPlus || hashEncoded;
        const query = queryString + '&vnp_SecureHash=' + vnp_SecureHash;

        const paymentUrl = vnpUrl + '?' + query;

        // Save payment record
        await pool.query(
            `INSERT INTO Payments (order_id, payment_method, payment_status, amount, transaction_id, created_at)
             VALUES ($1, 'vnpay', 'pending', $2, $3, NOW())
             ON CONFLICT (order_id) DO UPDATE SET payment_status = 'pending', transaction_id = $3, amount = $2`,
            [order.id, amount, txnRef]
        );

        res.json({ success: true, payUrl: paymentUrl, order_id: order.id, amount: amount, txnRef });

    } catch (error) {
        console.error('❌ VNPAY create-payment error:', error);
        res.status(500).json({ error: 'Lỗi tạo VNPay payment', detail: error.message });
    }
});

// VNPAY Return (user browser redirect)
router.get('/vnpay/return', async (req, res) => {
    const vnp_Params = req.query || {};
    const secureHash = vnp_Params.vnp_SecureHash;

    // Remove secure hash params for verification
    const cloneParams = Object.assign({}, vnp_Params);
    delete cloneParams.vnp_SecureHash;
    delete cloneParams.vnp_SecureHashType;

    const sortedKeys = Object.keys(cloneParams).sort();
    // Build candidate sign strings & hashes for verification
    const rawReturnSignData = sortedKeys.map(key => `${key}=${cloneParams[key]}`).join('&');
    const encodedReturnSignData = sortedKeys.map(key => `${key}=${encodeURIComponent(cloneParams[key])}`).join('&');
    const encodedReturnPlus = encodedReturnSignData.replace(/%20/g, '+');
    
    const expectedHashEncoded = crypto.createHmac('sha512', vnpayConfig.vnp_HashSecret).update(encodedReturnSignData).digest('hex');
    const expectedHashEncodedPlus = crypto.createHmac('sha512', vnpayConfig.vnp_HashSecret).update(encodedReturnPlus).digest('hex');
    const expectedHashRaw = crypto.createHmac('sha512', vnpayConfig.vnp_HashSecret).update(rawReturnSignData).digest('hex');

    // DEBUG
    console.log('🔍 VNPay return cloneParams:', cloneParams);
    console.log('🔍 VNPay return rawReturnSignData:', rawReturnSignData);
    console.log('🔍 VNPay return encodedReturnSignData:', encodedReturnSignData);
    console.log('🔍 VNPay return encodedReturnPlus:', encodedReturnPlus);
    console.log('🔍 VNPay return expectedHashEncoded:', expectedHashEncoded);
    console.log('🔍 VNPay return expectedHashEncodedPlus:', expectedHashEncodedPlus);
    console.log('🔍 VNPay return expectedHashRaw:', expectedHashRaw);
    console.log('🔍 VNPay return received secureHash:', secureHash);

    if (![expectedHashEncoded, expectedHashEncodedPlus, expectedHashRaw].includes(secureHash)) {
        console.error('❌ Invalid VNPay signature', { received: secureHash, expectedCandidates: [expectedHashEncoded, expectedHashEncodedPlus, expectedHashRaw] });
        return res.status(403).json({ error: 'Invalid signature' });
    }

    const txnRef = vnp_Params.vnp_TxnRef;
    const responseCode = vnp_Params.vnp_ResponseCode;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const paymentResult = await client.query(`SELECT order_id FROM Payments WHERE transaction_id = $1`, [txnRef]);
        if (paymentResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Payment not found' }); }
        const realOrderId = paymentResult.rows[0].order_id;

        if (responseCode === '00') {
            await client.query(`UPDATE Payments SET payment_status = 'paid', paid_at = NOW(), transaction_id = $1 WHERE order_id = $2`, [vnp_Params.vnp_TransactionNo || vnp_Params.vnp_TransId || txnRef, realOrderId]);

            // Debug: xác nhận payment -> order mapping và trạng thái order sau update
            console.log('🔎 VNPay return - paymentResult order_id:', realOrderId);
            const afterOrder = await client.query(`SELECT id, status FROM Orders WHERE id = $1`, [realOrderId]);
            console.log('🔎 VNPay return - order status after payment update:', afterOrder.rows[0]);

            const orderResult = await client.query(`SELECT buyer_id, seller_id, status FROM Orders WHERE id = $1`, [realOrderId]);
            if (orderResult.rows.length > 0) {
                const buyer_id = orderResult.rows[0].buyer_id;
                const seller_id = orderResult.rows[0].seller_id;
                const currentStatus = orderResult.rows[0].status;

                // Thông báo buyer
                const noti = await client.query(
                  `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                   VALUES ($1, NULL, 'payment', '✅ Thanh toán thành công', $2, $3, NOW()) RETURNING *`,
                  [buyer_id, `Đơn hàng #${realOrderId} đã được thanh toán qua VNPAY.`, realOrderId]
                );
                sendRealtimeNotification(req, buyer_id, noti.rows[0]);

                // Nếu đơn đang ở 'pending' thì chuyển sang 'processing' sau khi thanh toán
                if (currentStatus === 'pending') {
                    await client.query(`UPDATE Orders SET status = $1 WHERE id = $2`, ['processing', realOrderId]);
                    const sellerNoti = await client.query(
                      `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                       VALUES ($1, NULL, 'order_tracking', $2, $3, $4, NOW()) RETURNING *`,
                      [seller_id, '📣 Đơn đã thanh toán', `Đơn hàng #${realOrderId} đã được thanh toán. Vui lòng xử lý.`, realOrderId]
                    );
                    sendRealtimeNotification(req, seller_id, sellerNoti.rows[0]);
                }
            }

            await client.query('COMMIT');
            return res.json({ success: true, message: 'Thanh toán VNPAY thành công', order_id: realOrderId });
        } else {
            await client.query(`UPDATE Payments SET payment_status = 'failed' WHERE order_id = $1`, [realOrderId]);
            await client.query('COMMIT');
            return res.json({ success: false, message: 'Thanh toán thất bại', vnp_ResponseCode: responseCode });
        }

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ VNPAY return error:', error);
        res.status(500).json({ error: 'Internal error', detail: error.message });
    } finally {
        client.release();
    }
});

// VNPAY IPN (server to server)
router.post('/vnpay/ipn', async (req, res) => {
    const vnp_Params = req.body || req.query || {};
    const secureHash = vnp_Params.vnp_SecureHash;

    const cloneParams = Object.assign({}, vnp_Params);
    delete cloneParams.vnp_SecureHash;
    delete cloneParams.vnp_SecureHashType;

    const sortedKeys = Object.keys(cloneParams).sort();
    // Build candidate sign strings & hashes for IPN verification
    const rawIpnSignData = sortedKeys.map(key => `${key}=${cloneParams[key]}`).join('&');
    const encodedIpnSignData = sortedKeys.map(key => `${key}=${encodeURIComponent(cloneParams[key])}`).join('&');
    const encodedIpnPlus = encodedIpnSignData.replace(/%20/g, '+');
    
    const expectedHashIpnEncoded = crypto.createHmac('sha512', vnpayConfig.vnp_HashSecret).update(encodedIpnSignData).digest('hex');
    const expectedHashIpnEncodedPlus = crypto.createHmac('sha512', vnpayConfig.vnp_HashSecret).update(encodedIpnPlus).digest('hex');
    const expectedHashIpnRaw = crypto.createHmac('sha512', vnpayConfig.vnp_HashSecret).update(rawIpnSignData).digest('hex');

    // DEBUG
    console.log('🔔 VNPay IPN cloneParams:', cloneParams);
    console.log('🔔 VNPay IPN rawIpnSignData:', rawIpnSignData);
    console.log('🔔 VNPay IPN encodedIpnSignData:', encodedIpnSignData);
    console.log('🔔 VNPay IPN encodedIpnPlus:', encodedIpnPlus);
    console.log('🔔 VNPay IPN expectedHashIpnEncoded:', expectedHashIpnEncoded);
    console.log('🔔 VNPay IPN expectedHashIpnEncodedPlus:', expectedHashIpnEncodedPlus);
    console.log('🔔 VNPay IPN expectedHashIpnRaw:', expectedHashIpnRaw);
    console.log('🔔 VNPay IPN received secureHash:', secureHash);

    if (![expectedHashIpnEncoded, expectedHashIpnEncodedPlus, expectedHashIpnRaw].includes(secureHash)) {
        console.error('❌ Invalid VNPay IPN signature');
        return res.status(403).json({ RspCode: 97, Message: 'Invalid signature' });
    }

    const txnRef = vnp_Params.vnp_TxnRef;
    const responseCode = vnp_Params.vnp_ResponseCode;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const paymentResult = await client.query(`SELECT order_id FROM Payments WHERE transaction_id = $1`, [txnRef]);
        if (paymentResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ RspCode: '01', Message: 'Order not found' }); }

        const realOrderId = paymentResult.rows[0].order_id;
        if (responseCode === '00') {
            await client.query(`UPDATE Payments SET payment_status = 'paid', paid_at = NOW(), transaction_id = $1 WHERE order_id = $2`, [vnp_Params.vnp_TransactionNo || txnRef, realOrderId]);

            // Debug: xác nhận mapping và trạng thái order
            console.log('🔔 VNPay IPN - paymentResult order_id:', realOrderId);
            const afterOrderIpn = await client.query(`SELECT id, status FROM Orders WHERE id = $1`, [realOrderId]);
            console.log('🔔 VNPay IPN - order status after payment update:', afterOrderIpn.rows[0]);

            // Cập nhật trạng thái đơn và thông báo seller (nếu đang là 'pending')
            try {
                const orderRow = await client.query(`SELECT status, seller_id, buyer_id FROM Orders WHERE id = $1`, [realOrderId]);
                if (orderRow.rows.length > 0) {
                    const { status: curStatus, seller_id, buyer_id } = orderRow.rows[0];
                    if (curStatus === 'pending') {
                        await client.query(`UPDATE Orders SET status = $1 WHERE id = $2`, ['processing', realOrderId]);
                        await client.query(
                            `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                             VALUES ($1, NULL, 'order_tracking', $2, $3, $4, NOW())`,
                            [seller_id, '📣 Đơn đã thanh toán', `Đơn hàng #${realOrderId} đã được thanh toán. Vui lòng xử lý.`, realOrderId]
                        );
                        // gửi realtime nếu có socket
                        sendRealtimeNotification(req, seller_id, { order_id: realOrderId, message: 'Đơn đã được thanh toán' });
                    }
                    // gửi thông báo buyer nhẹ nhàng nếu cần
                    await client.query(
                        `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                         VALUES ($1, NULL, 'payment', '✅ Thanh toán thành công', $2, $3, NOW())`,
                        [buyer_id, `Đơn hàng #${realOrderId} đã được thanh toán qua VNPAY.`, realOrderId]
                    );
                }
            } catch (e) {
                console.error('VNPay IPN post-update error:', e);
            }
            await client.query('COMMIT');
            return res.json({ RspCode: '00', Message: 'Confirm Success' });
        } else {
            await client.query(`UPDATE Payments SET payment_status = 'failed' WHERE order_id = $1`, [realOrderId]);
            await client.query('COMMIT');
            return res.json({ RspCode: '02', Message: 'Confirm Failed' });
        }
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ VNPAY IPN processing error:', error);
        return res.status(500).json({ RspCode: 99, Message: 'Internal error' });
    } finally {
        client.release();
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
    } = req.body || {};

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

            // Debug: xác nhận mapping và trạng thái order
            console.log('🔔 MoMo callback - paymentResult order_id:', realOrderId);
            const afterOrderMomo = await client.query(`SELECT id, status FROM Orders WHERE id = $1`, [realOrderId]);
            console.log('🔔 MoMo callback - order status after payment update:', afterOrderMomo.rows[0]);

            // Lấy buyer_id để gửi thông báo
            const orderResult = await client.query(
                `SELECT buyer_id, seller_id, status FROM Orders WHERE id = $1`,
                [realOrderId]
            );

            if (orderResult.rows.length > 0) {
                const buyer_id = orderResult.rows[0].buyer_id;
                const seller_id = orderResult.rows[0].seller_id;
                const curStatus = orderResult.rows[0].status;

                // Tạo thông báo cho buyer
                const notiResult = await client.query(
                    `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                     VALUES ($1, NULL, 'payment', '✅ Thanh toán thành công', $2, $3, NOW()) RETURNING *`,
                    [buyer_id, `Đơn hàng #${realOrderId} đã được thanh toán qua MOMO. Mã GD: ${transId}`, realOrderId]
                );

                // Gửi socket realtime
                sendRealtimeNotification(req, buyer_id, notiResult.rows[0]);

                // Cập nhật trạng thái đơn (nếu đang pending) và thông báo seller
                if (curStatus === 'pending') {
                    await client.query(`UPDATE Orders SET status = $1 WHERE id = $2`, ['processing', realOrderId]);
                    const sellerNoti = await client.query(
                        `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                         VALUES ($1, NULL, 'order_tracking', $2, $3, $4, NOW()) RETURNING *`,
                        [seller_id, '📣 Đơn đã thanh toán', `Đơn hàng #${realOrderId} đã được thanh toán. Vui lòng xử lý.`, realOrderId]
                    );
                    sendRealtimeNotification(req, seller_id, sellerNoti.rows[0]);
                }
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
    const src = Object.assign({}, req.query || {}, req.params || {}, req.body || {});
    const { order_id } = src;
    
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
    const src = Object.assign({}, req.query || {}, req.params || {}, req.body || {});
    const { order_id } = src; // ✅ Nhận order_id (từ body/query/params)
    
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

            // Debug: xác nhận mapping và trạng thái order
            console.log('🔍 MoMo verify - paymentResult order_id:', order_id);
            const afterOrderVerify = await client.query(`SELECT id, status FROM Orders WHERE id = $1`, [order_id]);
            console.log('🔍 MoMo verify - order status after payment update:', afterOrderVerify.rows[0]);

            // Tạo thông báo
            // cập nhật trạng thái đơn nếu cần
            try {
                const orderRow = await client.query(`SELECT status, seller_id FROM Orders WHERE id = $1`, [order_id]);
                if (orderRow.rows.length > 0) {
                    const { status: curStatus, seller_id } = orderRow.rows[0];
                    if (curStatus === 'pending') {
                        await client.query(`UPDATE Orders SET status = $1 WHERE id = $2`, ['processing', order_id]);
                        await client.query(
                            `INSERT INTO Notifications (user_id, sender_id, type, title, message, order_id, created_at)
                             VALUES ($1, NULL, 'order_tracking', $2, $3, $4, NOW())`,
                            [seller_id, '📣 Đơn đã thanh toán', `Đơn hàng #${order_id} đã được thanh toán. Vui lòng xử lý.`, order_id]
                        );
                        sendRealtimeNotification(req, seller_id, { order_id, message: 'Đơn đã được thanh toán' });
                    }
                }
            } catch (e) {
                console.error('MoMo verify post-update error:', e);
            }
            
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