const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// --- HELPER: Gửi Socket Notification ---
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
// PHẦN 1: QUẢN LÝ DUYỆT HỒ SƠ (APPROVAL FLOW)
// ============================================================

// 1. Lấy danh sách đơn đang chờ
router.get('/pending-applications', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                app.id as application_id, 
                u.id as user_id, 
                u.full_name, u.email, u.phone_number,
                app.farm_address, app.business_license_url, app.created_at
            FROM FarmerApplications app
            JOIN Users u ON app.user_id = u.id
            WHERE app.status = 'pending'
            ORDER BY app.created_at ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Lỗi truy vấn database' });
    }
});

// 2. Duyệt đơn đăng ký (Approve)
router.patch('/approve-farmer/:userId', async (req, res) => {
    const { userId } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Cập nhật App
        const appUpdate = await client.query(
            `UPDATE FarmerApplications SET status = 'approved', updated_at = NOW() 
             WHERE user_id = $1 AND status = 'pending' RETURNING *`, [userId]
        );
        if (appUpdate.rows.length === 0) throw new Error('Không tìm thấy đơn chờ duyệt');

        // Cập nhật User Role
        const userUpdate = await client.query(
            `UPDATE Users SET role = 'farmer', updated_at = NOW() 
             WHERE id = $1 RETURNING full_name`, [userId]
        );

        // Tạo thông báo
        const notifyRes = await client.query(
            `INSERT INTO Notifications (user_id, type, title, message, created_at)
             VALUES ($1, 'system', 'Hồ sơ được duyệt', $2, NOW()) RETURNING *`,
            [userId, `Chúc mừng ${userUpdate.rows[0].full_name}, bạn đã trở thành Nông dân chính thức!`]
        );

        await client.query('COMMIT');
        sendRealtimeNotification(req, userId, notifyRes.rows[0]);
        res.json({ message: 'Duyệt thành công' });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
});

// 3. Từ chối đơn đăng ký (Reject)
router.patch('/reject-application/:userId', async (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            `UPDATE FarmerApplications SET status = 'rejected', notes = $1, updated_at = NOW()
             WHERE user_id = $2 AND status = 'pending' RETURNING *`,
            [reason || 'Không đạt yêu cầu', userId]
        );
        if (result.rows.length === 0) throw new Error('Không tìm thấy đơn chờ duyệt');

        const notifyRes = await client.query(
            `INSERT INTO Notifications (user_id, type, title, message, created_at)
             VALUES ($1, 'system', 'Hồ sơ bị từ chối', $2, NOW()) RETURNING *`,
            [userId, `Hồ sơ đăng ký bị từ chối. Lý do: ${reason || 'Không đạt yêu cầu'}`]
        );

        await client.query('COMMIT');
        sendRealtimeNotification(req, userId, notifyRes.rows[0]);
        res.json({ message: 'Đã từ chối hồ sơ' });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
});

// ============================================================
// PHẦN 2: QUẢN LÝ NGƯỜI DÙNG & NÔNG DÂN (MANAGEMENT FLOW)
// ============================================================

// 4. Lấy danh sách Người mua (Consumers) - Có tìm kiếm
router.get('/consumers', async (req, res) => {
    const { search } = req.query;
    try {
        let query = `
            SELECT id, full_name, email, phone_number, address, is_locked, created_at 
            FROM Users WHERE role = 'consumer'
        `;
        const params = [];
        if (search) {
            query += ` AND (full_name ILIKE $1 OR email ILIKE $1 OR phone_number ILIKE $1)`;
            params.push(`%${search}%`);
        }
        query += ` ORDER BY created_at DESC`;
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Lỗi lấy danh sách consumer' });
    }
});

// 5. Lấy danh sách Nông dân (Farmers) - Có tìm kiếm & thông tin trang trại
router.get('/farmers', async (req, res) => {
    const { search } = req.query;
    try {
        let query = `
            SELECT u.id, u.full_name, u.email, u.phone_number, u.is_locked, u.created_at,
                   fa.farm_address, fa.business_license_url
            FROM Users u
            LEFT JOIN FarmerApplications fa ON u.id = fa.user_id AND fa.status = 'approved'
            WHERE u.role = 'farmer'
        `;
        const params = [];
        if (search) {
            query += ` AND (u.full_name ILIKE $1 OR u.email ILIKE $1)`;
            params.push(`%${search}%`);
        }
        query += ` ORDER BY u.created_at DESC`;

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Lỗi lấy danh sách farmer' });
    }
});

// 6. Xem chi tiết 1 User
router.get('/:id', async (req, res) => {
    try {
        const userRes = await pool.query(
            `SELECT id, full_name, email, phone_number, address, role, is_locked, created_at 
             FROM Users WHERE id = $1`, [req.params.id]
        );
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const user = userRes.rows[0];
        let extraInfo = null;

        // Nếu là Farmer, lấy thêm thông tin trang trại
        if (user.role === 'farmer') {
            const farmRes = await pool.query(
                `SELECT farm_address, business_license_url FROM FarmerApplications WHERE user_id = $1`, [user.id]
            );
            extraInfo = farmRes.rows[0];
        }
        
        res.json({ user, extra_info: extraInfo });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi server' });
    }
});

// ============================================================
// PHẦN 3: TÁC VỤ QUẢN TRỊ (ACTIONS)
// ============================================================

// 7. Khóa / Mở khóa tài khoản (Block/Unblock)
router.patch('/:id/toggle-lock', async (req, res) => {
    const { id } = req.params;
    const { is_locked, reason } = req.body; // Nhận thêm lý do khóa
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            `UPDATE Users SET is_locked = $1, updated_at = NOW() WHERE id = $2 RETURNING full_name`,
            [is_locked, id]
        );
        if (result.rows.length === 0) throw new Error('User not found');

        // Gửi thông báo cho user biết số phận của mình
        const title = is_locked ? 'Tài khoản bị khóa' : 'Tài khoản được mở khóa';
        const msg = is_locked 
            ? `Tài khoản của bạn đã bị khóa. Lý do: ${reason || 'Vi phạm chính sách'}.`
            : `Tài khoản của bạn đã được mở khóa. Hãy tuân thủ quy định nhé.`;

        const notifyRes = await client.query(
            `INSERT INTO Notifications (user_id, type, title, message, created_at)
             VALUES ($1, 'security', $2, $3, NOW()) RETURNING *`,
            [id, title, msg]
        );

        await client.query('COMMIT');
        sendRealtimeNotification(req, id, notifyRes.rows[0]);
        
        res.json({ message: is_locked ? 'Đã khóa tài khoản' : 'Đã mở khóa' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
});

// 8. Tước quyền Farmer (Hạ cấp xuống Consumer)
// Dùng khi Farmer bán hàng giả, gian lận
router.patch('/:id/demote-farmer', async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Đổi role về consumer
        const userUpdate = await client.query(
            `UPDATE Users SET role = 'consumer' WHERE id = $1 AND role = 'farmer' RETURNING full_name`,
            [id]
        );
        if (userUpdate.rows.length === 0) throw new Error('User không phải Farmer');

        // Thu hồi đơn đăng ký
        await client.query(
            `UPDATE FarmerApplications SET status = 'revoked', notes = $1 WHERE user_id = $2`,
            [`Bị tước quyền. Lý do: ${reason}`, id]
        );

        // Thông báo
        const notifyRes = await client.query(
            `INSERT INTO Notifications (user_id, type, title, message, created_at)
             VALUES ($1, 'system', 'Thu hồi quyền Nông dân', $2, NOW()) RETURNING *`,
            [id, `Bạn đã bị tước quyền Nông dân. Lý do: ${reason || 'Vi phạm nghiêm trọng'}.`]
        );

        await client.query('COMMIT');
        sendRealtimeNotification(req, id, notifyRes.rows[0]);
        
        res.json({ message: 'Đã tước quyền Farmer thành công' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
});

module.exports = router;