const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const multer = require('multer');

// Cấu hình lưu file vào thư mục uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // Thư mục uploads/
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname); // Tên file duy nhất
  }
});
const upload = multer({ storage: storage });

// Lấy thông tin cá nhân theo id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, full_name, email, phone_number, address, role FROM Users WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Khong tim thay user' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Loi truy van user' });
  }
});

// Cập nhật thông tin cá nhân
router.put('/:id', async (req, res) => {
  try {
    const { full_name, phone_number, address } = req.body;
    const result = await pool.query(
      'UPDATE Users SET full_name=$1, phone_number=$2, address=$3, updated_at=NOW() WHERE id=$4 RETURNING id, full_name, email, phone_number, address, role',
      [full_name, phone_number, address, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Khong tim thay user' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Loi cap nhat user' });
  }
});

// --- 3. API MỚI: User nộp đơn đăng ký làm Farmer ---
// API: POST /api/profile/:id/apply-farmer
router.post('/:id/apply-farmer', upload.single('business_license'), async (req, res) => {
  const { id } = req.params; // Lấy user_id từ URL
  const { farm_address } = req.body;
  // Nếu có file thì lấy đường dẫn file, nếu không thì lấy từ req.body.business_license_url
  const business_license_url = req.file ? '/uploads/' + req.file.filename : req.body.business_license_url;

  if (!farm_address) {
    return res.status(400).json({ error: 'Dia chi nong trai la bat buoc' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO FarmerApplications (user_id, farm_address, business_license_url, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (user_id) DO UPDATE SET
          status = 'pending', 
          farm_address = $2, 
          business_license_url = $3, 
          updated_at = NOW()
       RETURNING *`,
      [id, farm_address, business_license_url]
    );
    res.status(201).json({ message: 'Nop don thanh cong', application: result.rows[0] });
  } catch (err) {
    console.error(err.message);
    if (err.code === '23503') { // Lỗi khóa ngoại
         return res.status(404).json({ error: 'Khong tim thay user ID nay de nop don' });
    }
    res.status(500).json({ error: 'Loi khi nop don', detail: err.message });
  }
});

module.exports = router;
