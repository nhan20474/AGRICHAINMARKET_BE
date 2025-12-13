const express = require('express');
const router = express.Router();
const chatbotService = require('../services/chatbotService');

// POST /api/chatbot/message - Gửi tin nhắn
router.post('/message', async (req, res) => {
  try {
    const { user_id, message } = req.body;

    if (!user_id || !message) {
      return res.status(400).json({ error: 'Thiếu user_id hoặc message' });
    }

    const context = await chatbotService.getUserContext(user_id);
    const response = await chatbotService.generateResponse(message, context);

    // ✅ THÊM: Lưu tin nhắn + response vào database
    await chatbotService.saveChatHistory(user_id, message, response, context);

    // Gửi realtime qua Socket.IO
    const io = req.app.get('io');
    if (io && io.userSockets && io.userSockets[user_id]) {
      const sockets = io.userSockets[user_id];
      (Array.isArray(sockets) ? sockets : [sockets]).forEach(socketId => {
        io.to(socketId).emit('chatbot_response', { message, response });
      });
    }

    res.json({ message, response, timestamp: new Date() });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi chatbot', detail: err.message });
  }
});

// GET /api/chatbot/history/:userId - Lịch sử chat
router.get('/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 20;

    const history = await chatbotService.getChatHistory(userId, limit);
    res.json(history);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi lấy lịch sử chat' });
  }
});

// DELETE /api/chatbot/history/:userId - Xóa lịch sử
router.delete('/history/:userId', async (req, res) => {
  try {
    const pool = require('../config/database');
    await pool.query('DELETE FROM ChatMessages WHERE user_id = $1', [req.params.userId]);
    res.json({ message: 'Đã xóa lịch sử chat' });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi xóa lịch sử' });
  }
});

module.exports = router;
