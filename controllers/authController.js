const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const emailService = require('../services/emailService');
const crypto = require('crypto');

const SECRET_KEY = 'your_secret_key_here_change_in_production';

// Dang ky
exports.register = async (req, res) => {
  try {
    const { full_name, email, password, phone_number, address, role } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({ error: 'Vui long nhap day du thong tin' });
    }

    const userExists = await pool.query(
      'SELECT * FROM Users WHERE email = $1',
      [email]
    );

    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Email da ton tai' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await pool.query(
      'INSERT INTO Users (full_name, email, password_hash, phone_number, address, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, full_name, email, role',
      [full_name, email, hashedPassword, phone_number, address, role || 'consumer']
    );

    res.status(201).json({
      message: 'Dang ky thanh cong!',
      user: newUser.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Loi server' });
  }
};

// Dang nhap
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Kiem tra du lieu dau vao
    if (!email || !password) {
      return res.status(400).json({ error: 'Vui long nhap email va password' });
    }

    // Tim user trong database theo email
    const user = await pool.query(
      'SELECT * FROM Users WHERE email = $1',
      [email]
    );

    if (user.rows.length === 0) {
      return res.status(401).json({ error: 'Email khong dung' });
    }

    // Kiem tra mat khau
    const validPassword = await bcrypt.compare(password, user.rows[0].password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Password khong dung' });
    }

    if (user.rows[0].is_locked) {
        return res.status(403).json({ message: "Tài khoản của bạn đã bị khóa." });
    }

    // Tao JWT token
    const token = jwt.sign(
      { 
        id: user.rows[0].id,
        full_name: user.rows[0].full_name,
        email: user.rows[0].email,
        role: user.rows[0].role
      },
      SECRET_KEY,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Dang nhap thanh cong!',
      token: token,
      user: {
        id: user.rows[0].id,
        full_name: user.rows[0].full_name,
        email: user.rows[0].email,
        phone_number: user.rows[0].phone_number,
        address: user.rows[0].address,
        role: user.rows[0].role
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Loi server' });
  }
};

// ============================================================
// 🔥 QUÊN MẬT KHẨU - GỬI EMAIL LINK RESET
// ============================================================
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Vui lòng nhập email' });
    }

    // Kiểm tra email có tồn tại không
    const userResult = await pool.query(
      'SELECT id, full_name FROM Users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Email không tồn tại trong hệ thống' });
    }

    // Tạo reset token (random string)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 giờ

    // Lưu token vào database
    await pool.query(
      `UPDATE Users SET 
         reset_token = $1, 
         reset_token_expires = $2,
         updated_at = NOW()
       WHERE email = $3`,
      [hashedToken, expiresAt, email]
    );

    // Gửi email với link reset
    await emailService.sendResetPasswordEmail(email, resetToken);

    res.json({
      success: true,
      message: 'Link đặt lại mật khẩu đã được gửi đến email của bạn'
    });

  } catch (err) {
    console.error('Lỗi quên mật khẩu:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
};

// ============================================================
// 🔥 ĐẶT LẠI MẬT KHẨU VỚI TOKEN
// ============================================================
exports.resetPassword = async (req, res) => {
  try {
    const { token, new_password } = req.body;

    if (!token || !new_password) {
      return res.status(400).json({ error: 'Thiếu thông tin' });
    }

    // Hash token từ URL để so sánh
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Tìm user có token hợp lệ
    const userResult = await pool.query(
      `SELECT * FROM Users 
       WHERE reset_token = $1 
       AND reset_token_expires > NOW()`,
      [hashedToken]
    );

    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Link reset không hợp lệ hoặc đã hết hạn' });
    }

    const user = userResult.rows[0];

    // Mã hóa mật khẩu mới
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // Cập nhật mật khẩu và xóa token
    await pool.query(
      `UPDATE Users SET 
         password_hash = $1, 
         reset_token = NULL, 
         reset_token_expires = NULL,
         updated_at = NOW()
       WHERE id = $2`,
      [hashedPassword, user.id]
    );

    // Gửi email xác nhận
    await emailService.sendPasswordChangeConfirmation(user.email, user.full_name);

    res.json({
      success: true,
      message: 'Đặt lại mật khẩu thành công'
    });

  } catch (err) {
    console.error('Lỗi reset password:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
};

// ============================================================
// 🔥 ĐỔI MẬT KHẨU (Khi đã đăng nhập)
// ============================================================
exports.changePassword = async (req, res) => {
  try {
    const { user_id, old_password, new_password } = req.body;

    if (!user_id || !old_password || !new_password) {
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
    }

    // Lấy thông tin user
    const userResult = await pool.query(
      'SELECT * FROM Users WHERE id = $1',
      [user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    }

    const user = userResult.rows[0];

    // Kiểm tra mật khẩu cũ
    const validPassword = await bcrypt.compare(old_password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Mật khẩu cũ không đúng' });
    }

    // Kiểm tra mật khẩu mới không trùng cũ
    const samePassword = await bcrypt.compare(new_password, user.password_hash);
    if (samePassword) {
      return res.status(400).json({ error: 'Mật khẩu mới không được trùng với mật khẩu cũ' });
    }

    // Mã hóa mật khẩu mới
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // Cập nhật mật khẩu
    await pool.query(
      'UPDATE Users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hashedPassword, user_id]
    );

    // Gửi email xác nhận
    await emailService.sendPasswordChangeConfirmation(user.email, user.full_name);

    res.json({
      success: true,
      message: 'Đổi mật khẩu thành công'
    });

  } catch (err) {
    console.error('Lỗi đổi mật khẩu:', err);
    res.status(500).json({ error: 'Lỗi server', detail: err.message });
  }
};
