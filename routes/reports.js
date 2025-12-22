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

        let targetDate = req.body.date;
        if (!targetDate) {
            const d = new Date();
            d.setDate(d.getDate() - 1);
            targetDate = d.toISOString().split('T')[0];
        }

        // ===== A. SELLER =====
        const sellerStats = await client.query(`
            SELECT 
                o.seller_id,
                COUNT(DISTINCT o.id) AS total_orders,
                COALESCE(SUM(o.total_amount),0) AS total_revenue,
                COALESCE(SUM(o.discount_amount),0) AS total_discount,
                COALESCE(SUM(oi.quantity),0) AS total_quantity
            FROM Orders o
            LEFT JOIN OrderItems oi ON o.id = oi.order_id
            WHERE DATE(o.created_at) = $1
              AND o.status IN ('delivered','received')
            GROUP BY o.seller_id
        `, [targetDate]);

        for (const s of sellerStats.rows) {
            await client.query(`
                INSERT INTO Reports
                (report_date, seller_id, total_orders, total_quantity, total_revenue, total_discount)
                VALUES ($1,$2,$3,$4,$5,$6)
                ON CONFLICT (report_date, seller_id)
                DO UPDATE SET
                    total_orders = EXCLUDED.total_orders,
                    total_quantity = EXCLUDED.total_quantity,
                    total_revenue = EXCLUDED.total_revenue,
                    total_discount = EXCLUDED.total_discount
            `, [
                targetDate,
                s.seller_id,
                s.total_orders,
                s.total_quantity,
                s.total_revenue,
                s.total_discount
            ]);
        }

        // ===== B. ADMIN =====
        const adminStats = await client.query(`
            SELECT 
                COUNT(DISTINCT o.id) AS total_orders,
                COALESCE(SUM(o.total_amount),0) AS total_revenue,
                COALESCE(SUM(o.discount_amount),0) AS total_discount,
                COALESCE(SUM(oi.quantity),0) AS total_quantity
            FROM Orders o
            LEFT JOIN OrderItems oi ON o.id = oi.order_id
            WHERE DATE(o.created_at) = $1
              AND o.status IN ('delivered','received')
        `, [targetDate]);

        const a = adminStats.rows[0];

        await client.query(`
            INSERT INTO Reports
            (report_date, seller_id, total_orders, total_quantity, total_revenue, total_discount)
            VALUES ($1,NULL,$2,$3,$4,$5)
            ON CONFLICT ON CONSTRAINT unique_daily_admin_report
            DO UPDATE SET
                total_orders = EXCLUDED.total_orders,
                total_quantity = EXCLUDED.total_quantity,
                total_revenue = EXCLUDED.total_revenue,
                total_discount = EXCLUDED.total_discount
        `, [
            targetDate,
            a.total_orders,
            a.total_quantity,
            a.total_revenue,
            a.total_discount
        ]);

        await client.query('COMMIT');
        res.json({ message: `Sync report ${targetDate} OK` });

    } catch (err) {
        await client.query('ROLLBACK');
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

        const from = from_date || '2024-01-01';
        const to = to_date || new Date().toISOString().split('T')[0];

        let sql = '';
        const params = [from, to];

        if (type === 'monthly') {
            sql = `
                SELECT 
                    TO_CHAR(DATE_TRUNC('month', report_date), 'YYYY-MM') AS label,
                    SUM(total_revenue) AS revenue,
                    SUM(total_orders) AS orders
                FROM Reports
                WHERE report_date BETWEEN $1 AND $2
                  AND product_id IS NULL
            `;
        } else {
            sql = `
                SELECT 
                    TO_CHAR(report_date,'YYYY-MM-DD') AS label,
                    total_revenue AS revenue,
                    total_orders AS orders
                FROM Reports
                WHERE report_date BETWEEN $1 AND $2
                  AND product_id IS NULL
            `;
        }

        if (seller_id) {
            sql += ` AND seller_id = $3`;
            params.push(seller_id);
        } else {
            sql += ` AND seller_id IS NULL`;
        }

        sql += type === 'monthly'
            ? ` GROUP BY DATE_TRUNC('month', report_date) ORDER BY label`
            : ` ORDER BY report_date`;

        const result = await pool.query(sql, params);
        res.json(result.rows);

    } catch (err) {
        res.status(500).json({ error: err.message });
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