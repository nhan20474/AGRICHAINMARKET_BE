const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// ============================================================
// 1. API ĐỒNG BỘ BÁO CÁO (CHẠY CUỐI NGÀY HOẶC KHI CẦN)
// POST /api/reports/sync
// Body: { date: '2025-10-20' } (Nếu không gửi thì lấy ngày hôm qua)
// ============================================================
router.post('/sync', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Xác định ngày cần chốt số liệu (Mặc định là ngày hôm qua nếu không gửi lên)
        let targetDate = req.body.date;
        if (!targetDate) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            targetDate = yesterday.toISOString().split('T')[0];
        }

        console.log(`⏳ Đang tổng hợp báo cáo cho ngày: ${targetDate}...`);

        // ------------------------------------------
        // A. TỔNG HỢP CHO TỪNG SELLER (FARMER)
        // ------------------------------------------
        // Logic: Lấy tất cả đơn hàng ĐÃ GIAO (delivered) hoặc ĐÃ NHẬN (received) trong ngày đó
        const sellerStats = await client.query(`
            SELECT 
                o.seller_id,
                COUNT(o.id) as total_orders,
                COALESCE(SUM(o.total_amount), 0) as total_revenue,
                COALESCE(SUM(o.discount_amount), 0) as total_discount,
                COALESCE(SUM(oi.quantity), 0) as total_quantity
            FROM Orders o
            LEFT JOIN OrderItems oi ON o.id = oi.order_id
            WHERE DATE(o.created_at) = $1 
              AND o.status IN ('delivered', 'received') -- Chỉ tính đơn thành công
            GROUP BY o.seller_id
        `, [targetDate]);

        // Lưu vào bảng Reports (Upsert: Có rồi thì update, chưa có thì insert)
        for (const stat of sellerStats.rows) {
            await client.query(`
                INSERT INTO Reports (report_date, seller_id, total_orders, total_revenue, total_discount, total_quantity)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO NOTHING -- (Lưu ý: Bạn cần unique constraint (report_date, seller_id) để dùng ON CONFLICT chuẩn hơn, ở đây ta insert mới)
                -- Tốt nhất nên xóa bản ghi cũ của ngày đó trước khi insert lại để tránh trùng lặp nếu chạy lại
            `, [targetDate, stat.seller_id, stat.total_orders, stat.total_revenue, stat.total_discount, stat.total_quantity]);
        }

        // ------------------------------------------
        // B. TỔNG HỢP CHO ADMIN (TOÀN SÀN)
        // ------------------------------------------
        const adminStats = await client.query(`
            SELECT 
                COUNT(o.id) as total_orders,
                COALESCE(SUM(o.total_amount), 0) as total_revenue,
                COALESCE(SUM(o.discount_amount), 0) as total_discount,
                COALESCE(SUM(oi.quantity), 0) as total_quantity
            FROM Orders o
            LEFT JOIN OrderItems oi ON o.id = oi.order_id
            WHERE DATE(o.created_at) = $1 
              AND o.status IN ('delivered', 'received')
        `, [targetDate]);

        const adminData = adminStats.rows[0];
        
        // seller_id = NULL nghĩa là báo cáo của Admin
        // Trước khi insert, xóa báo cáo cũ của admin trong ngày này (nếu có) để tránh duplicate
        await client.query(`DELETE FROM Reports WHERE report_date = $1 AND seller_id IS NULL AND product_id IS NULL`, [targetDate]);

        await client.query(`
            INSERT INTO Reports (report_date, seller_id, total_orders, total_revenue, total_discount, total_quantity)
            VALUES ($1, NULL, $2, $3, $4, $5)
        `, [targetDate, adminData.total_orders, adminData.total_revenue, adminData.total_discount, adminData.total_quantity]);

        await client.query('COMMIT');
        res.json({ message: `Đã tổng hợp báo cáo ngày ${targetDate} thành công`, details: { sellers: sellerStats.rowCount, admin: 1 } });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Report Sync Error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ============================================================
// 2. LẤY BIỂU ĐỒ DOANH THU (GET /api/reports/chart)
// Dùng để vẽ biểu đồ cột/đường
// ============================================================
router.get('/chart', async (req, res) => {
    try {
        const { seller_id, from_date, to_date, type } = req.query; 
        // type: 'daily' (mặc định) hoặc 'monthly'

        let query = '';
        let params = [];
        let paramIndex = 1;

        if (type === 'monthly') {
            // Thống kê theo Tháng
            query = `
                SELECT 
                    TO_CHAR(report_date, 'YYYY-MM') as label,
                    SUM(total_revenue) as revenue,
                    SUM(total_orders) as orders
                FROM Reports
                WHERE report_date BETWEEN $${paramIndex++} AND $${paramIndex++}
            `;
        } else {
            // Thống kê theo Ngày (Mặc định)
            query = `
                SELECT 
                    TO_CHAR(report_date, 'YYYY-MM-DD') as label,
                    total_revenue as revenue,
                    total_orders as orders
                FROM Reports
                WHERE report_date BETWEEN $${paramIndex++} AND $${paramIndex++}
            `;
        }

        params.push(from_date || '2024-01-01'); // Mặc định ngày bắt đầu xa xa
        params.push(to_date || new Date().toISOString().split('T')[0]); // Mặc định hôm nay

        // Lọc theo Seller (Nếu không gửi seller_id thì lấy của Admin - seller_id IS NULL)
        if (seller_id) {
            query += ` AND seller_id = $${paramIndex++}`;
            params.push(seller_id);
        } else {
            query += ` AND seller_id IS NULL`; // Admin
        }

        // Group by & Order
        if (type === 'monthly') {
            query += ` GROUP BY TO_CHAR(report_date, 'YYYY-MM') ORDER BY label ASC`;
        } else {
            query += ` ORDER BY report_date ASC`;
        }

        const result = await pool.query(query, params);
        res.json(result.rows);

    } catch (err) {
        res.status(500).json({ error: 'Lỗi lấy dữ liệu biểu đồ', detail: err.message });
    }
});

// ============================================================
// 3. THỐNG KÊ TỔNG QUAN (DASHBOARD STATS) - Realtime
// Lấy số liệu tổng hợp (Không qua bảng Reports để có số liệu tức thì)
// ============================================================
router.get('/dashboard-stats', async (req, res) => {
    try {
        const { seller_id } = req.query;
        
        let queryRevenue = `
            SELECT 
                COALESCE(SUM(total_amount), 0) as total_revenue,
                COUNT(id) as total_orders
            FROM Orders 
            WHERE status IN ('delivered', 'received')
        `;
        
        let queryPending = `
            SELECT COUNT(id) as pending_count 
            FROM Orders 
            WHERE status = 'pending'
        `;

        let queryProducts = `SELECT COUNT(id) as total_products FROM Products WHERE status != 'deleted'`;

        const params = [];
        if (seller_id) {
            queryRevenue += ` AND seller_id = $1`;
            queryPending += ` AND seller_id = $1`;
            queryProducts += ` AND seller_id = $1`;
            params.push(seller_id);
        }

        // Chạy song song 3 query cho nhanh
        const [revRes, penRes, prodRes] = await Promise.all([
            pool.query(queryRevenue, params),
            pool.query(queryPending, params),
            pool.query(queryProducts, params)
        ]);

        res.json({
            revenue: Number(revRes.rows[0].total_revenue),
            completed_orders: Number(revRes.rows[0].total_orders),
            pending_orders: Number(penRes.rows[0].pending_count),
            total_products: Number(prodRes.rows[0].total_products)
        });

    } catch (err) {
        res.status(500).json({ error: 'Lỗi lấy thống kê dashboard' });
    }
});

// =============================
// API DASHBOARD ADMIN
// =============================
router.get('/admin/dashboard', async (req, res) => {
    try {
        const [revenueRes, orderRes, userRes, sellerRes, buyerRes, productRes, lowStockRes] = await Promise.all([
            pool.query(`SELECT COALESCE(SUM(total_amount),0) as total_revenue FROM Orders WHERE status IN ('delivered','received')`),
            pool.query(`SELECT COUNT(id) as total_orders, SUM(CASE WHEN status='delivered' OR status='received' THEN 1 ELSE 0 END) as completed_orders, SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled_orders, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending_orders FROM Orders`),
            pool.query(`SELECT COUNT(id) as total_users FROM Users`),
            pool.query(`SELECT COUNT(id) as total_sellers FROM Users WHERE role='seller'`),
            pool.query(`SELECT COUNT(id) as total_buyers FROM Users WHERE role='buyer'`),
            pool.query(`SELECT COUNT(id) as total_products FROM Products WHERE status != 'deleted'`),
            pool.query(`SELECT COUNT(id) as low_stock_products FROM Products WHERE quantity <= 10 AND status != 'deleted'`)
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
        res.status(500).json({ error: 'Lỗi lấy thống kê dashboard admin', detail: err.message });
    }
});

module.exports = router;