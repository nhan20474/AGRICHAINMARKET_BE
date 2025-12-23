const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// ============================================================
// 1. Dashboard Overview - Tổng quan hệ thống
// GET /api/reports/admin/dashboard
// ============================================================
router.get('/admin/dashboard', async (req, res) => {
    try {
        const [
            revenueRes,
            orderRes,
            userRes,
            sellerRes,
            buyerRes,
            productRes,
            lowStockRes
        ] = await Promise.all([
            // Tổng doanh thu
            pool.query(`SELECT COALESCE(SUM(total_amount),0) AS total_revenue FROM Orders WHERE status IN ('delivered','received')`),
            // Thống kê đơn hàng theo trạng thái
            pool.query(`
                SELECT 
                    COUNT(id) AS total_orders,
                    SUM(CASE WHEN status IN ('delivered','received') THEN 1 ELSE 0 END) AS completed_orders,
                    SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled_orders,
                    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_orders
                FROM Orders
            `),
            // Tổng người dùng
            pool.query(`SELECT COUNT(id) AS total_users FROM Users`),
            // Tổng seller
            pool.query(`SELECT COUNT(id) AS total_sellers FROM Users WHERE role='seller'`),
            // Tổng buyer
            pool.query(`SELECT COUNT(id) AS total_buyers FROM Users WHERE role='buyer'`),
            // Tổng sản phẩm
            pool.query(`SELECT COUNT(id) AS total_products FROM Products WHERE status != 'deleted'`),
            // Sản phẩm tồn kho thấp
            pool.query(`SELECT COUNT(id) AS low_stock_products FROM Products WHERE quantity <= 10 AND status != 'deleted'`)
        ]);

        res.json({
            total_revenue: Number(revenueRes.rows[0].total_revenue),
            total_orders: Number(orderRes.rows[0].total_orders),
            completed_orders: Number(orderRes.rows[0].completed_orders),
            cancelled_orders: Number(orderRes.rows[0].cancelled_orders),
            pending_orders: Number(orderRes.rows[0].pending_orders),
            total_users: Number(userRes.rows[0].total_users),
            total_sellers: Number(sellerRes.rows[0].total_sellers),
            total_buyers: Number(buyerRes.rows[0].total_buyers),
            total_products: Number(productRes.rows[0].total_products),
            low_stock_products: Number(lowStockRes.rows[0].low_stock_products)
        });

    } catch (err) {
        console.error('❌ ADMIN DASHBOARD ERROR:', err);
        res.status(500).json({ success: false, message: 'Failed to load admin dashboard', detail: err.message });
    }
});

// ============================================================
// 2. Admin Sales Trend (Doanh thu theo ngày/tháng)
// GET /api/reports/admin/trend?type=daily|monthly&from=yyyy-mm-dd&to=yyyy-mm-dd
// ============================================================
// GET /api/reports/admin/trend
router.get('/admin/trend', async (req, res) => {
    const { type, from, to } = req.query;
    const start = from || '2024-01-01';
    const end = to || new Date().toISOString().split('T')[0];

    try {
        let sql = '';
        if (type === 'monthly') {
            sql = `
                SELECT 
                    TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS label,
                    COUNT(id) AS total_orders,
                    COALESCE(SUM(total_amount),0) AS total_revenue
                    -- Đã xóa dòng total_quantity để tránh lỗi
                FROM orders
                WHERE status IN ('delivered','received')
                  AND created_at BETWEEN $1 AND $2
                GROUP BY DATE_TRUNC('month', created_at)
                ORDER BY label
            `;
        } else { // daily
            sql = `
                SELECT 
                    TO_CHAR(created_at,'YYYY-MM-DD') AS label,
                    COUNT(id) AS total_orders,
                    COALESCE(SUM(total_amount),0) AS total_revenue
                FROM orders
                WHERE status IN ('delivered','received')
                  AND created_at BETWEEN $1 AND $2
                GROUP BY created_at
                ORDER BY created_at
            `;
        }

        const result = await pool.query(sql, [start, end]);
        res.json({ success: true, trend: result.rows });

    } catch (err) {
        console.error('❌ ADMIN TREND ERROR:', err.message);
        res.status(500).json({ success: false, message: 'Failed to load trend' });
    }
});

// ============================================================
// 3. Admin Top Products
// GET /api/reports/admin/top-products?limit=5
// ============================================================
router.get('/admin/top-products', async (req, res) => {
    const limit = parseInt(req.query.limit) || 5;

    try {
        const result = await pool.query(`
            SELECT 
                oi.product_id,
                -- Nếu muốn lấy tên sp, cần join bảng products: p.name
                SUM(oi.quantity) AS total_sold, 
                SUM(oi.price_per_item * oi.quantity) AS revenue
            FROM orderitems oi
            JOIN orders o ON o.id = oi.order_id
            WHERE o.status IN ('delivered', 'received')
            GROUP BY oi.product_id
            ORDER BY total_sold DESC
            LIMIT $1
        `, [limit]);

        res.json({ success: true, top_products: result.rows });

    } catch (err) {
        console.error('❌ ADMIN TOP PRODUCTS ERROR:', err.message);
        res.status(500).json({ success: false, message: 'Failed to load top products' });
    }
});

// ============================================================
// 4. Manual Sync Report (Đồng bộ thủ công)
// POST /api/reports/sync
// Body: { "date": "YYYY-MM-DD" }
// ============================================================
router.post('/sync', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Xác định ngày cần Sync (nếu không gửi thì lấy ngày hôm qua)
        let targetDate = req.body.date;
        if (!targetDate) {
            const d = new Date();
            d.setDate(d.getDate() - 1);
            targetDate = d.toISOString().split('T')[0];
        }

        console.log(`🔄 Đang Sync dữ liệu cho ngày: ${targetDate}`);

        // --------------------------------------------------------
        // A. SYNC CHO FARMER (Từng người bán)
        // --------------------------------------------------------
        // Tính toán số liệu từ bảng orders + orderitems
        const sellerStats = await client.query(`
            SELECT 
                o.seller_id,
                COUNT(DISTINCT o.id)              AS total_orders,
                COALESCE(SUM(oi.quantity), 0)     AS total_quantity,
                COALESCE(SUM(oi.price_per_item * oi.quantity), 0) AS total_revenue,
                COALESCE(SUM(o.discount_amount), 0) AS total_discount
            FROM orders o
            LEFT JOIN orderitems oi ON o.id = oi.order_id
            WHERE DATE(o.created_at) = $1
              AND o.status IN ('delivered', 'received')
            GROUP BY o.seller_id
        `, [targetDate]);

        // Lưu vào bảng reports
        for (const s of sellerStats.rows) {
            await client.query(`
                INSERT INTO reports (
                    report_date, seller_id, 
                    total_orders, total_quantity, total_revenue, total_discount, 
                    updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                ON CONFLICT (report_date, seller_id) WHERE seller_id IS NOT NULL
                DO UPDATE SET
                    total_orders   = EXCLUDED.total_orders,
                    total_quantity = EXCLUDED.total_quantity,
                    total_revenue  = EXCLUDED.total_revenue,
                    total_discount = EXCLUDED.total_discount,
                    updated_at     = CURRENT_TIMESTAMP
            `, [
                targetDate, s.seller_id, 
                s.total_orders, s.total_quantity, s.total_revenue, s.total_discount
            ]);
        }

        // --------------------------------------------------------
        // B. SYNC CHO ADMIN (Toàn hệ thống)
        // --------------------------------------------------------
        const adminStats = await client.query(`
            SELECT 
                COUNT(DISTINCT o.id)              AS total_orders,
                COALESCE(SUM(oi.quantity), 0)     AS total_quantity,
                COALESCE(SUM(oi.price_per_item * oi.quantity), 0) AS total_revenue,
                COALESCE(SUM(o.discount_amount), 0) AS total_discount
            FROM orders o
            LEFT JOIN orderitems oi ON o.id = oi.order_id
            WHERE DATE(o.created_at) = $1
              AND o.status IN ('delivered', 'received')
        `, [targetDate]);

        const a = adminStats.rows[0] || { total_orders: 0, total_quantity: 0, total_revenue: 0, total_discount: 0 };

        await client.query(`
            INSERT INTO reports (
                report_date, seller_id, 
                total_orders, total_quantity, total_revenue, total_discount, 
                updated_at
            )
            VALUES ($1, NULL, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (report_date) WHERE seller_id IS NULL
            DO UPDATE SET
                total_orders   = EXCLUDED.total_orders,
                total_quantity = EXCLUDED.total_quantity,
                total_revenue  = EXCLUDED.total_revenue,
                total_discount = EXCLUDED.total_discount,
                updated_at     = CURRENT_TIMESTAMP
        `, [
            targetDate, 
            a.total_orders, a.total_quantity, a.total_revenue, a.total_discount
        ]);

        await client.query('COMMIT');
        res.json({ success: true, message: `Sync thành công cho ngày ${targetDate}` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ SYNC ERROR:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ============================================================
// 1. Farmer All-time Statistics (Tổng hợp toàn thời gian)
// GET /api/reports/farmer/:sellerId/all-time
// ============================================================
router.get('/farmer/:sellerId/all-time', async (req, res) => {
    const { sellerId } = req.params;
    if (!sellerId || isNaN(sellerId)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid sellerId'
        });
    }

    try {
        const result = await pool.query(`
            SELECT
                COUNT(id) AS total_orders,                    -- Tổng số đơn hàng
                COALESCE(SUM(total_amount), 0) AS total_revenue,     -- Tổng doanh thu
                COALESCE(SUM(discount_amount), 0) AS total_discount, -- Tổng giá trị giảm giá
                CASE WHEN COUNT(id) > 0 THEN COALESCE(SUM(total_amount)/COUNT(id),0) ELSE 0 END AS average_order_value, -- Giá trị trung bình mỗi đơn
                SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_orders,
                SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled_orders
            FROM orders
            WHERE seller_id = $1
              AND status IN ('delivered', 'received', 'pending', 'cancelled')
        `, [sellerId]);

        res.json({
            success: true,
            seller_id: Number(sellerId),
            data: result.rows[0]
        });

    } catch (err) {
        console.error('❌ FARMER ALL-TIME ERROR:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to load seller all-time statistics'
        });
    }
});

// ============================================================
// 2. Farmer Sales Trend (Biểu đồ doanh thu theo ngày/tháng)
// GET /api/reports/farmer/:sellerId/trend?type=daily|monthly&from=yyyy-mm-dd&to=yyyy-mm-dd
// ============================================================
router.get('/farmer/:sellerId/trend', async (req, res) => {
    const { sellerId } = req.params;
    const { type, from, to } = req.query;

    const start = from || '2024-01-01';
    const end = to || new Date().toISOString().split('T')[0];

    try {
        let sql = '';
        
        // Logic: Phải JOIN bảng 'orders' với 'orderitems'
        // orders: Để lấy ngày tháng (created_at) và trạng thái (status)
        // orderitems: Để lấy số lượng (quantity) và tính lại doanh thu chính xác từ sản phẩm
        
        if (type === 'monthly') {
            sql = `
                SELECT 
                    TO_CHAR(DATE_TRUNC('month', o.created_at), 'YYYY-MM') AS label,
                    COUNT(DISTINCT o.id) AS total_orders,        -- Đếm số đơn (DISTINCT vì join sẽ nhân bản dòng)
                    COALESCE(SUM(oi.quantity), 0) AS total_quantity, -- Tổng số lượng item
                    COALESCE(SUM(oi.price_per_item * oi.quantity), 0) AS total_revenue -- Tính doanh thu từ item để chính xác
                FROM orders o
                LEFT JOIN orderitems oi ON o.id = oi.order_id
                WHERE o.seller_id = $1
                  AND o.status IN ('delivered','received')
                  AND o.created_at BETWEEN $2 AND $3
                GROUP BY DATE_TRUNC('month', o.created_at)
                ORDER BY label
            `;
        } else { // daily
            sql = `
                SELECT 
                    TO_CHAR(o.created_at,'YYYY-MM-DD') AS label,
                    COUNT(DISTINCT o.id) AS total_orders,
                    COALESCE(SUM(oi.quantity), 0) AS total_quantity,
                    COALESCE(SUM(oi.price_per_item * oi.quantity), 0) AS total_revenue
                FROM orders o
                LEFT JOIN orderitems oi ON o.id = oi.order_id
                WHERE o.seller_id = $1
                  AND o.status IN ('delivered','received')
                  AND o.created_at BETWEEN $2 AND $3
                GROUP BY DATE(o.created_at), TO_CHAR(o.created_at,'YYYY-MM-DD')
                ORDER BY label
            `;
        }

        const result = await pool.query(sql, [sellerId, start, end]);
        res.json({ success: true, trend: result.rows });

    } catch (err) {
        console.error('❌ FARMER TREND ERROR:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ============================================================
// 3. Farmer Top Products (Sản phẩm bán chạy nhất)
// GET /api/reports/farmer/:sellerId/top-products?limit=5
// ============================================================
router.get('/farmer/:sellerId/top-products', async (req, res) => {
    const { sellerId } = req.params;
    const limit = parseInt(req.query.limit) || 5;

    try {
        // Cần JOIN bảng orders để lấy seller_id và lọc status
        const result = await pool.query(`
            SELECT 
                oi.product_id, 
                SUM(oi.quantity) AS total_sold, 
                SUM(oi.price_per_item * oi.quantity) AS revenue
            FROM orderitems oi
            JOIN orders o ON oi.order_id = o.id  -- JOIN BẢNG ORDERS
            WHERE o.seller_id = $1
              AND o.status IN ('delivered', 'received') -- Chỉ tính đơn thành công
            GROUP BY oi.product_id
            ORDER BY total_sold DESC
            LIMIT $2
        `, [sellerId, limit]);

        res.json({ success: true, top_products: result.rows });

    } catch (err) {
        console.error('❌ FARMER TOP PRODUCTS ERROR:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
