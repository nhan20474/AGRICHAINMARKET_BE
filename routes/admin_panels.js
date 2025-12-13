const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database'); // Đảm bảo đường dẫn đúng

/* ---------------------------------------------
   MULTER CONFIG (Xử lý upload ảnh)
--------------------------------------------- */
const uploadDir = path.join(__dirname, '../uploads/panels');

// Tạo thư mục nếu chưa có
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Đặt tên file: timestamp-random.ext
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    },
});

// Filter chỉ cho phép ảnh
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Chỉ được upload file ảnh!'), false);
    }
};

const upload = multer({ storage: storage, fileFilter: fileFilter });

/* ---------------------------------------------
   1. GET ALL PANELS
--------------------------------------------- */
router.get('/', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM panels ORDER BY id DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('GET /panels error:', error);
        res.status(500).json({ error: 'Lỗi lấy danh sách panels' });
    }
});

/* ---------------------------------------------
   2. GET PANEL BY ID
--------------------------------------------- */
router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM panels WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy Panel' });
        res.json(result.rows[0]);
    } catch (error) {
        console.error('GET /panels/:id error:', error);
        res.status(500).json({ error: 'Lỗi lấy chi tiết panel' });
    }
});

/* ---------------------------------------------
   3. CREATE PANEL (POST)
--------------------------------------------- */
router.post('/', upload.array('images'), async (req, res) => {
    try {
        const { name, description, page, content } = req.body;

        // Xử lý ảnh mới upload
        // Lưu đường dẫn tương đối để frontend dễ gọi (VD: /uploads/panels/abc.jpg)
        const images = req.files ? req.files.map((f) => `/uploads/panels/${f.filename}`) : [];

        // Parse content an toàn (vì formData gửi object dưới dạng string)
        let parsedContent = {};
        try {
            parsedContent = content ? JSON.parse(content) : {};
        } catch (e) {
            parsedContent = content; // Nếu không phải JSON string thì giữ nguyên
        }

        const result = await pool.query(
            `INSERT INTO panels (name, description, page, content, images, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             RETURNING *`,
            [
                name,
                description || '',
                page || 'home',
                JSON.stringify(parsedContent),
                JSON.stringify(images),
            ]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('POST /panels error:', err);
        res.status(500).json({ error: 'Lỗi tạo panel', detail: err.message });
    }
});

/* ---------------------------------------------
   4. UPDATE PANEL (PUT)
--------------------------------------------- */
router.put('/:id', upload.array('images'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, page, content, old_images } = req.body;

        // 1. Xử lý ảnh cũ (Giữ lại những ảnh user không xóa)
        let finalImages = [];
        if (old_images) {
            try {
                // FormData gửi mảng dưới dạng string hoặc lặp lại key
                if (Array.isArray(old_images)) {
                    finalImages = old_images;
                } else {
                    // Cố gắng parse nếu là JSON string, hoặc coi như 1 string đơn
                    try {
                        finalImages = JSON.parse(old_images);
                    } catch {
                        finalImages = [old_images];
                    }
                }
            } catch (e) {
                console.error("Lỗi parse old_images", e);
                finalImages = [];
            }
        }

        // 2. Thêm ảnh mới upload
        if (req.files && req.files.length > 0) {
            const newImgPaths = req.files.map((f) => `/uploads/panels/${f.filename}`);
            finalImages = [...finalImages, ...newImgPaths];
        }

        // 3. Parse content
        let parsedContent = {};
        try {
            parsedContent = content ? JSON.parse(content) : {};
        } catch (e) {
            parsedContent = content;
        }

        const result = await pool.query(
            `UPDATE panels 
             SET name = $1,
                 description = $2,
                 page = $3,
                 content = $4,
                 images = $5,
                 updated_at = NOW()
             WHERE id = $6
             RETURNING *`,
            [
                name,
                description,
                page,
                JSON.stringify(parsedContent),
                JSON.stringify(finalImages), // Lưu mảng ảnh mới (cũ + mới)
                id,
            ]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Không tìm thấy Panel' });

        res.json(result.rows[0]);
    } catch (err) {
        console.error('PUT /panels/:id error:', err);
        res.status(500).json({ error: 'Lỗi cập nhật panel', detail: err.message });
    }
});

/* ---------------------------------------------
   5. DELETE PANEL (Xóa cả file ảnh trong thư mục)
--------------------------------------------- */
router.delete('/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params;

        // 1. Lấy danh sách ảnh để xóa file vật lý
        const check = await client.query('SELECT images FROM panels WHERE id = $1', [id]);
        if (check.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Panel không tồn tại' });
        }

        // 2. Xóa trong DB
        await client.query('DELETE FROM panels WHERE id = $1', [id]);
        await client.query('COMMIT');

        // 3. Xóa file ảnh trong thư mục uploads (Dọn rác)
        const images = check.rows[0].images || [];
        if (Array.isArray(images)) {
            images.forEach((imgUrl) => {
                // imgUrl dạng "/uploads/panels/abc.jpg" -> cần chuyển về đường dẫn hệ thống
                // Loại bỏ dấu "/" đầu tiên để path.join hoạt động đúng từ root dự án
                const relativePath = imgUrl.startsWith('/') ? imgUrl.slice(1) : imgUrl;
                const filePath = path.join(__dirname, '../', relativePath);
                
                if (fs.existsSync(filePath)) {
                    fs.unlink(filePath, (err) => {
                        if (err) console.error('Không thể xóa file:', filePath);
                    });
                }
            });
        }

        res.json({ message: 'Xóa thành công' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('DELETE /panels/:id error:', error);
        res.status(500).json({ error: 'Lỗi xóa panel' });
    } finally {
        client.release();
    }
});

/* ---------------------------------------------
   6. REMOVE SINGLE IMAGE (Xóa 1 ảnh khỏi Panel)
--------------------------------------------- */
router.delete('/:id/image', async (req, res) => {
    try {
        const { id } = req.params;
        const { imageUrl } = req.body; // URL ảnh cần xóa

        if (!imageUrl) return res.status(400).json({ error: 'Thiếu imageUrl' });

        // 1. Lấy dữ liệu hiện tại
        const result = await pool.query('SELECT images FROM panels WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Panel không tồn tại' });

        const oldImages = result.rows[0].images || [];
        
        // 2. Lọc bỏ ảnh cần xóa
        const newImages = oldImages.filter((img) => img !== imageUrl);

        // 3. Cập nhật DB
        await pool.query(
            'UPDATE panels SET images = $1, updated_at = NOW() WHERE id = $2',
            [JSON.stringify(newImages), id]
        );

        // 4. Xóa file vật lý
        const relativePath = imageUrl.startsWith('/') ? imageUrl.slice(1) : imageUrl;
        const filePath = path.join(__dirname, '../', relativePath);
        
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) console.error('Không thể xóa file ảnh lẻ:', filePath);
            });
        }

        res.json({ message: 'Đã xóa ảnh thành công', images: newImages });
    } catch (error) {
        console.error('DELETE image error:', error);
        res.status(500).json({ error: 'Lỗi xóa ảnh lẻ' });
    }
});

module.exports = router;