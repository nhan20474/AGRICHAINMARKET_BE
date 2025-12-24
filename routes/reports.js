const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// ============================================================
// UTILITY: Validate Date Format
// ============================================================
const isValidDate = (dateStr) => {
  if (!dateStr) return true; // optional
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(new Date(dateStr));
};

// ============================================================
// 1. Dashboard Overview - OPTIMIZED (Merged 7 queries → 1)
// GET /api/reports/admin/dashboard
// ============================================================
router.get('/admin/dashboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                -- Revenue Stats
                (SELECT COALESCE(SUM(total_amount), 0) 
                 FROM orders WHERE status IN ('delivered','received')) AS total_revenue,
                
                -- Order Stats
                (SELECT COUNT(id) FROM orders) AS total_orders,
                (SELECT COUNT(id) FROM orders WHERE status IN ('delivered','received')) AS completed_orders,
                (SELECT COUNT(id) FROM orders WHERE status='cancelled') AS cancelled_orders,
                (SELECT COUNT(id) FROM orders WHERE status='pending') AS pending_orders,
                
                -- User Stats
                (SELECT COUNT(id) FROM users) AS total_users,
                (SELECT COUNT(id) FROM users WHERE role='seller') AS total_sellers,
                (SELECT COUNT(id) FROM users WHERE role='buyer') AS total_buyers,
                
                -- Product Stats
                (SELECT COUNT(id) FROM products WHERE status != 'deleted') AS total_products,
                (SELECT COUNT(id) FROM products WHERE quantity <= 10 AND status != 'deleted') AS low_stock_products
        `);

        const data = result.rows[0];
        res.json({
            total_revenue: Number(data.total_revenue),
            total_orders: Number(data.total_orders),
            completed_orders: Number(data.completed_orders),
            cancelled_orders: Number(data.cancelled_orders),
            pending_orders: Number(data.pending_orders),
            total_users: Number(data.total_users),
            total_sellers: Number(data.total_sellers),
            total_buyers: Number(data.total_buyers),
            total_products: Number(data.total_products),
            low_stock_products: Number(data.low_stock_products)
        });

    } catch (err) {
        console.error('❌ ADMIN DASHBOARD ERROR:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load admin dashboard', 
            detail: err.message 
        });
    }
});

// ============================================================
// 2. Admin Sales Trend - WITH VALIDATION
// GET /api/reports/admin/trend?type=daily|monthly&from=yyyy-mm-dd&to=yyyy-mm-dd
// ============================================================
router.get('/admin/trend', async (req, res) => {
    const { type, from, to } = req.query;
    
    // Validate date format
    if (from && !isValidDate(from)) {
        return res.status(400).json({ 
            success: false, 
            message: 'Invalid from date format (use YYYY-MM-DD)' 
        });
    }
    if (to && !isValidDate(to)) {
        return res.status(400).json({ 
            success: false, 
            message: 'Invalid to date format (use YYYY-MM-DD)' 
        });
    }

    const start = from || '2024-01-01';
    const end = to || new Date().toISOString().split('T')[0];

    try {
        let sql = '';
        if (type === 'monthly') {
            sql = `
                SELECT 
                    TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS label,
                    COUNT(id) AS total_orders,
                    COALESCE(SUM(total_amount), 0)::NUMERIC AS total_revenue
                FROM orders
                WHERE status IN ('delivered','received')
                  AND created_at::date BETWEEN $1::date AND $2::date
                GROUP BY DATE_TRUNC('month', created_at)
                ORDER BY label ASC
            `;
        } else { 
            // daily
            sql = `
                SELECT 
                    created_at::date AS label,
                    COUNT(id) AS total_orders,
                    COALESCE(SUM(total_amount), 0)::NUMERIC AS total_revenue
                FROM orders
                WHERE status IN ('delivered','received')
                  AND created_at::date BETWEEN $1::date AND $2::date
                GROUP BY created_at::date
                ORDER BY label ASC
            `;
        }

        const result = await pool.query(sql, [start, end]);
        res.json({ success: true, trend: result.rows });

    } catch (err) {
        console.error('❌ ADMIN TREND ERROR:', err.message);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load trend',
            detail: err.message 
        });
    }
});

// ============================================================
// 3. Admin Top Products - OPTIMIZED (WITH Product Details)
// GET /api/reports/admin/top-products?limit=5
// ============================================================
router.get('/admin/top-products', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 5, 100); // Cap at 100

    try {
        const result = await pool.query(`
            SELECT 
                oi.product_id,
                p.name,
                p.image_url,
                p.price,
                SUM(oi.quantity)::INTEGER AS total_sold,
                SUM(oi.price_per_item * oi.quantity)::NUMERIC AS revenue,
                COUNT(DISTINCT oi.order_id)::INTEGER AS order_count
            FROM orderitems oi
            JOIN orders o ON o.id = oi.order_id
            JOIN products p ON p.id = oi.product_id
            WHERE o.status IN ('delivered', 'received')
            GROUP BY oi.product_id, p.name, p.image_url, p.price
            ORDER BY total_sold DESC
            LIMIT $1
        `, [limit]);

        res.json({ success: true, top_products: result.rows });

    } catch (err) {
        console.error('❌ ADMIN TOP PRODUCTS ERROR:', err.message);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load top products',
            detail: err.message 
        });
    }
});

// ============================================================
// 4. Manual Sync Report - CACHE BUILDER
// POST /api/reports/sync
// Body: { "date": "YYYY-MM-DD" }
// ============================================================
router.post('/sync', async (req, res) => {
    const client = await pool.connect();
    try {
        // Validate date if provided
        if (req.body.date && !isValidDate(req.body.date)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid date format (use YYYY-MM-DD)' 
            });
        }

        await client.query('BEGIN');

        // Determine target date (default: yesterday)
        let targetDate = req.body.date;
        if (!targetDate) {
            const d = new Date();
            d.setDate(d.getDate() - 1);
            targetDate = d.toISOString().split('T')[0];
        }

        console.log(`🔄 Syncing report data for date: ${targetDate}`);

        // ========== SELLER REPORTS ==========
        const sellerStats = await client.query(`
            SELECT 
                o.seller_id,
                COUNT(DISTINCT o.id)::INTEGER AS total_orders,
                COALESCE(SUM(oi.quantity), 0)::INTEGER AS total_quantity,
                COALESCE(SUM(oi.price_per_item * oi.quantity), 0)::NUMERIC AS total_revenue,
                COALESCE(SUM(o.discount_amount), 0)::NUMERIC AS total_discount
            FROM orders o
            LEFT JOIN orderitems oi ON o.id = oi.order_id
            WHERE DATE(o.created_at) = $1::date
              AND o.status IN ('delivered', 'received')
              AND o.seller_id IS NOT NULL
            GROUP BY o.seller_id
        `, [targetDate]);

        // Upsert seller reports
        for (const s of sellerStats.rows) {
            await client.query(`
                INSERT INTO reports (
                    report_date, seller_id, 
                    total_orders, total_quantity, total_revenue, total_discount, 
                    updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                ON CONFLICT (report_date, seller_id) 
                WHERE seller_id IS NOT NULL
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

        // ========== ADMIN OVERALL REPORT ==========
        const adminStats = await client.query(`
            SELECT 
                COUNT(DISTINCT o.id)::INTEGER AS total_orders,
                COALESCE(SUM(oi.quantity), 0)::INTEGER AS total_quantity,
                COALESCE(SUM(oi.price_per_item * oi.quantity), 0)::NUMERIC AS total_revenue,
                COALESCE(SUM(o.discount_amount), 0)::NUMERIC AS total_discount
            FROM orders o
            LEFT JOIN orderitems oi ON o.id = oi.order_id
            WHERE DATE(o.created_at) = $1::date
              AND o.status IN ('delivered', 'received')
        `, [targetDate]);

        const a = adminStats.rows[0] || { 
            total_orders: 0, 
            total_quantity: 0, 
            total_revenue: 0, 
            total_discount: 0 
        };

        await client.query(`
            INSERT INTO reports (
                report_date, seller_id, 
                total_orders, total_quantity, total_revenue, total_discount, 
                updated_at
            )
            VALUES ($1, NULL, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (report_date, seller_id)
            WHERE seller_id IS NULL
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
        res.json({ 
            success: true, 
            message: `Report synced successfully for ${targetDate}`,
            data: {
                date: targetDate,
                sellers_updated: sellerStats.rows.length,
                admin_updated: 1
            }
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ SYNC ERROR:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to sync report',
            detail: err.message 
        });
    } finally {
        client.release();
    }
});

// ============================================================
// 5. Farmer All-time Statistics
// GET /api/reports/farmer/:sellerId/all-time
// ============================================================
router.get('/farmer/:sellerId/all-time', async (req, res) => {
    const { sellerId } = req.params;
    
    if (!sellerId || isNaN(parseInt(sellerId))) {
        return res.status(400).json({
            success: false,
            message: 'Invalid sellerId'
        });
    }

    try {
        const result = await pool.query(`
            SELECT
                COUNT(id)::INTEGER AS total_orders,
                COALESCE(SUM(total_amount), 0)::NUMERIC AS total_revenue,
                COALESCE(SUM(discount_amount), 0)::NUMERIC AS total_discount,
                CASE WHEN COUNT(id) > 0 
                     THEN (COALESCE(SUM(total_amount), 0) / COUNT(id))::NUMERIC 
                     ELSE 0 
                END AS average_order_value,
                SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END)::INTEGER AS pending_orders,
                SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END)::INTEGER AS cancelled_orders,
                SUM(CASE WHEN status IN ('delivered','received') THEN 1 ELSE 0 END)::INTEGER AS completed_orders
            FROM orders
            WHERE seller_id = $1
              AND status IN ('delivered', 'received', 'pending', 'cancelled')
        `, [sellerId]);

        if (result.rows.length === 0) {
            return res.json({
                success: true,
                seller_id: Number(sellerId),
                data: {
                    total_orders: 0,
                    total_revenue: 0,
                    total_discount: 0,
                    average_order_value: 0,
                    pending_orders: 0,
                    cancelled_orders: 0,
                    completed_orders: 0
                }
            });
        }

        res.json({
            success: true,
            seller_id: Number(sellerId),
            data: result.rows[0]
        });

    } catch (err) {
        console.error('❌ FARMER ALL-TIME ERROR:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to load seller statistics',
            detail: err.message
        });
    }
});

// ============================================================
// 6. Farmer Sales Trend
// GET /api/reports/farmer/:sellerId/trend?type=daily|monthly&from=YYYY-MM-DD&to=YYYY-MM-DD
// ============================================================
router.get('/farmer/:sellerId/trend', async (req, res) => {
    const { sellerId } = req.params;
    const { type, from, to } = req.query;

    if (!sellerId || isNaN(parseInt(sellerId))) {
        return res.status(400).json({
            success: false,
            message: 'Invalid sellerId'
        });
    }

    // Validate dates
    if (from && !isValidDate(from)) {
        return res.status(400).json({ 
            success: false, 
            message: 'Invalid from date format (use YYYY-MM-DD)' 
        });
    }
    if (to && !isValidDate(to)) {
        return res.status(400).json({ 
            success: false, 
            message: 'Invalid to date format (use YYYY-MM-DD)' 
        });
    }

    const start = from || '2024-01-01';
    const end = to || new Date().toISOString().split('T')[0];

    try {
        let sql = '';
        
        if (type === 'monthly') {
            sql = `
                SELECT 
                    TO_CHAR(DATE_TRUNC('month', o.created_at), 'YYYY-MM') AS label,
                    COUNT(DISTINCT o.id)::INTEGER AS total_orders,
                    COALESCE(SUM(oi.quantity), 0)::INTEGER AS total_quantity,
                    COALESCE(SUM(oi.price_per_item * oi.quantity), 0)::NUMERIC AS total_revenue
                FROM orders o
                LEFT JOIN orderitems oi ON o.id = oi.order_id
                WHERE o.seller_id = $1
                  AND o.status IN ('delivered','received')
                  AND o.created_at::date BETWEEN $2::date AND $3::date
                GROUP BY DATE_TRUNC('month', o.created_at)
                ORDER BY label ASC
            `;
        } else { 
            // daily
            sql = `
                SELECT 
                    o.created_at::date AS label,
                    COUNT(DISTINCT o.id)::INTEGER AS total_orders,
                    COALESCE(SUM(oi.quantity), 0)::INTEGER AS total_quantity,
                    COALESCE(SUM(oi.price_per_item * oi.quantity), 0)::NUMERIC AS total_revenue
                FROM orders o
                LEFT JOIN orderitems oi ON o.id = oi.order_id
                WHERE o.seller_id = $1
                  AND o.status IN ('delivered','received')
                  AND o.created_at::date BETWEEN $2::date AND $3::date
                GROUP BY o.created_at::date
                ORDER BY label ASC
            `;
        }

        const result = await pool.query(sql, [sellerId, start, end]);
        res.json({ success: true, trend: result.rows });

    } catch (err) {
        console.error('❌ FARMER TREND ERROR:', err.message);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load trend',
            detail: err.message 
        });
    }
});

// ============================================================
// 7. Farmer Top Products - OPTIMIZED (WITH Product Details)
// GET /api/reports/farmer/:sellerId/top-products?limit=5
// ============================================================
router.get('/farmer/:sellerId/top-products', async (req, res) => {
    const { sellerId } = req.params;
    
    if (!sellerId || isNaN(parseInt(sellerId))) {
        return res.status(400).json({
            success: false,
            message: 'Invalid sellerId'
        });
    }

    const limit = Math.min(parseInt(req.query.limit) || 5, 100); // Cap at 100

    try {
        const result = await pool.query(`
            SELECT 
                oi.product_id,
                p.name,
                p.image_url,
                p.price,
                SUM(oi.quantity)::INTEGER AS total_sold,
                SUM(oi.price_per_item * oi.quantity)::NUMERIC AS revenue,
                COUNT(DISTINCT oi.order_id)::INTEGER AS order_count
            FROM orderitems oi
            JOIN orders o ON oi.order_id = o.id
            JOIN products p ON oi.product_id = p.id
            WHERE o.seller_id = $1
              AND o.status IN ('delivered', 'received')
            GROUP BY oi.product_id, p.name, p.image_url, p.price
            ORDER BY total_sold DESC
            LIMIT $2
        `, [sellerId, limit]);

        res.json({ success: true, top_products: result.rows });

    } catch (err) {
        console.error('❌ FARMER TOP PRODUCTS ERROR:', err.message);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to load top products',
            detail: err.message 
        });
    }
});

module.exports = router;
