const express = require('express');
const router = express.Router();
const { contract, signer } = require('../config/blockchain'); // Config blockchain
const pool = require('../config/database'); // <-- 1. Import kết nối Database

// Thêm log lên blockchain VÀ lưu vào Database
router.post('/add-log', async (req, res) => {
  const client = await pool.connect(); // Mở kết nối DB để dùng Transaction

  try {
    // Lấy thêm notes và image_url để lưu vào DB (Blockchain không lưu cái này cho nhẹ)
    const { productId, action, location, notes, image_url } = req.body;

    // --- BƯỚC 1: GHI LÊN BLOCKCHAIN ---
    if (!signer) {
      return res.status(500).json({ error: 'Chưa cấu hình ví Admin (Signer)' });
    }

    console.log(`[Blockchain] Đang ghi log cho SP #${productId}...`);
    
    // Gửi transaction tới smart contract
    const tx = await contract.addLog(productId, action, location);
    
    // Đợi xác nhận (Mining)
    const receipt = await tx.wait();
    const txHash = tx.hash; // <-- Lấy được mã Hash quan trọng này
    
    console.log(`[Blockchain] Thành công! Hash: ${txHash}`);

    // --- BƯỚC 2: LƯU VÀO DATABASE (PostgreSQL) ---
    await client.query('BEGIN'); // Bắt đầu giao dịch DB

    // 2a. Lấy dữ liệu cũ trong bảng Provenance (nếu có) để nối thêm vào
    const currentRes = await client.query(
        'SELECT production_steps FROM Provenance WHERE product_id = $1',
        [productId]
    );

    let steps = [];
    if (currentRes.rows.length > 0 && currentRes.rows[0].production_steps) {
        steps = currentRes.rows[0].production_steps.steps || [];
    }

    // 2b. Tạo object bước mới (Có chứa txHash để đối chiếu sau này)
    const newStep = {
        date: new Date().toISOString(),
        action: action,
        location: location,
        notes: notes || '',         // Dữ liệu bổ sung
        image_url: image_url || '', // Dữ liệu bổ sung
        tx_hash: txHash,            // <--- LƯU CHỨNG CỨ BLOCKCHAIN VÀO ĐÂY
        explorer_url: `https://amoy.polygonscan.com/tx/${txHash}` // Link kiểm tra nhanh
    };

    // Thêm vào mảng lịch sử
    steps.push(newStep);

    // 2c. Lưu ngược lại vào DB (Upsert: Nếu chưa có thì thêm, có rồi thì cập nhật)
    // Cập nhật cột blockchain_transaction_id bằng hash mới nhất
    const query = `
        INSERT INTO Provenance (product_id, blockchain_transaction_id, production_steps, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (product_id) 
        DO UPDATE SET 
            blockchain_transaction_id = $2, 
            production_steps = $3,          
            updated_at = NOW()
        RETURNING *
    `;
    
    await client.query(query, [productId, txHash, { steps: steps }]);

    await client.query('COMMIT'); // Lưu thay đổi DB thành công

    // --- BƯỚC 3: PHẢN HỒI ---
    res.json({
      success: true,
      message: 'Đã ghi nhật ký Blockchain và lưu Database thành công',
      txHash: txHash,
      blockNumber: receipt.blockNumber,
      step: newStep
    });

  } catch (err) {
    await client.query('ROLLBACK'); // Nếu lỗi DB thì hoàn tác (Blockchain ko hoàn tác được nhưng ít nhất DB ko bị lỗi)
    console.error('add-log error:', err);
    
    res.status(500).json({
      success: false,
      error: err.message || err.toString()
    });
  } finally {
    client.release(); // Giải phóng kết nối DB
  }
});

// Lấy số lượng log của product (Đọc trực tiếp từ Blockchain để verify)
router.get('/count/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const count = await contract.getLogCount(productId);
    res.json({
      success: true,
      count: count.toString()
    });
  } catch (err) {
    console.error('get count error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Lấy chi tiết log theo index (Đọc trực tiếp từ Blockchain)
router.get('/log/:productId/:index', async (req, res) => {
  try {
    const { productId, index } = req.params;
    const log = await contract.productLogs(productId, index); // Truy cập mảng public mapping

    res.json({
      success: true,
      log: {
        action: log.action,
        location: log.location,
        timestamp: Number(log.timestamp),
        recorder: log.recorder
      }
    });
  } catch (err) {
    console.error('get log error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// API: Lấy toàn bộ lịch sử canh tác từ Database (JSONB)
// GET /api/blockchain/:productId
router.get('/:productId', async (req, res) => {
  try {
    const result = await pool.query(
        'SELECT production_steps FROM Provenance WHERE product_id = $1',
        [req.params.productId]
    );
    
    if (result.rows.length === 0) {
        return res.json([]); // Trả về mảng rỗng nếu chưa có dữ liệu
    }
    
    // Trả về mảng các bước (steps)
    const steps = result.rows[0].production_steps.steps || [];
    res.json(steps);

  } catch (err) {
    console.error('Get history error:', err);
    res.status(500).json({ error: 'Lỗi lấy dữ liệu' });
  }
});

module.exports = router;