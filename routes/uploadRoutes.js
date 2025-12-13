const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');

// Cấu hình lưu file vào thư mục uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../uploads/'));
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// API: POST /api/upload
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Vui long chon file de upload' });
  }
  // Trả về đường dẫn file vừa upload
  res.json({ 
    message: 'Upload thanh cong', 
    fileUrl: '/uploads/' + req.file.filename 
  });
});

module.exports = router;
