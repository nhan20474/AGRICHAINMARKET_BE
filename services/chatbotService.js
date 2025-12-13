const pool = require('../config/database');
const { GoogleGenerativeAI } = require('@google/generative-ai');

class ChatbotService {
  constructor() {
    this.genAI = null;
    
    if (process.env.GEMINI_API_KEY) {
      try {
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        console.log('✅ Gemini API initialized');
      } catch (err) {
        console.error('⚠️ Gemini init failed:', err);
      }
    } else {
      console.error('❌ GEMINI_API_KEY not found in .env');
    }

    this.systemPrompt = `Bạn là trợ lý AI của AgriChain - sàn TMĐT nông sản Việt Nam.

NHIỆM VỤ:
- Tư vấn sản phẩm nông sản (rau củ, trái cây, gạo, gia vị)
- Hỗ trợ đơn hàng, thanh toán, giao hàng
- Hướng dẫn truy xuất nguồn gốc Blockchain
- Giải đáp thắc mắc về nền tảng

QUY TẮC:
- Trả lời ngắn gọn (max 150 từ), thân thiện
- Dùng tiếng Việt có dấu
- Dùng emoji phù hợp 🌾 🥬 🍎 📦
- Nếu không biết, gợi ý liên hệ admin`;
  }

  // Tạo response từ Gemini
  async generateResponse(message, context = {}) {
    if (!this.genAI) {
      return 'Xin lỗi, chatbot chưa được khởi tạo. Vui lòng liên hệ admin.';
    }

    try {
      // ✅ SỬA: Đổi từ 'gemini-1.5-flash' sang 'gemini-2.5-flash'
      const model = this.genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash'
      });
      
      // Build context từ database
      const userContext = await this.buildUserContext(context.userId);
      const contextText = this.buildContextText(userContext);
      
      const prompt = `${this.systemPrompt}\n\n${contextText}\n\nKhách hỏi: ${message}\n\nTrả lời:`;
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();

    } catch (error) {
      console.error('Gemini Error:', error.message);
      return 'Xin lỗi, tôi đang gặp sự cố. Vui lòng thử lại sau hoặc liên hệ hotline: 0901234567';
    }
  }

  // Build context từ database
  async buildUserContext(userId) {
    if (!userId) return {};

    try {
      const [orders, cart, products] = await Promise.all([
        pool.query(
          `SELECT id, total_amount, status FROM Orders 
           WHERE buyer_id = $1 ORDER BY created_at DESC LIMIT 3`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*) as items FROM CartItems WHERE user_id = $1`,
          [userId]
        ),
        pool.query(
          `SELECT name, price, quantity, unit FROM Products 
           WHERE status = 'available' ORDER BY quantity DESC LIMIT 5`
        )
      ]);

      return {
        recentOrders: orders.rows,
        cartItems: parseInt(cart.rows[0].items),
        topProducts: products.rows
      };
    } catch (err) {
      return {};
    }
  }

  // Build context text cho Gemini
  buildContextText(userContext) {
    let text = 'THÔNG TIN HỆ THỐNG:\n';

    if (userContext.recentOrders?.length > 0) {
      text += '\n📦 Đơn hàng gần nhất:\n';
      userContext.recentOrders.forEach(o => {
        text += `- Đơn #${o.id}: ${o.total_amount.toLocaleString()}đ (${o.status})\n`;
      });
    }

    if (userContext.cartItems > 0) {
      text += `\n🛒 Giỏ hàng: ${userContext.cartItems} sản phẩm\n`;
    }

    if (userContext.topProducts?.length > 0) {
      text += '\n🌾 Sản phẩm đang có:\n';
      userContext.topProducts.forEach(p => {
        text += `- ${p.name}: ${p.price.toLocaleString()}đ/${p.unit}\n`;
      });
    }

    return text;
  }

  // Lấy context user
  async getUserContext(userId) {
    try {
      const [orders, cart] = await Promise.all([
        pool.query('SELECT COUNT(*) as total FROM Orders WHERE buyer_id = $1', [userId]),
        pool.query('SELECT COUNT(*) as items FROM CartItems WHERE user_id = $1', [userId])
      ]);

      return {
        userId: userId,
        hasOrders: orders.rows[0].total > 0,
        cartItems: parseInt(cart.rows[0].items)
      };
    } catch (err) {
      return { userId: userId };
    }
  }

  // Lưu lịch sử chat
  async saveChatHistory(userId, message, response, context) {
    try {
      await pool.query(
        `INSERT INTO ChatMessages (user_id, message, response, context) 
         VALUES ($1, $2, $3, $4)`,
        [userId, message, response, JSON.stringify(context)]
      );
    } catch (err) {
      console.error('Save chat error:', err);
    }
  }

  // Lấy lịch sử chat
  async getChatHistory(userId, limit = 20) {
    try {
      const result = await pool.query(
        `SELECT message, response, created_at 
         FROM ChatMessages 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2`,
        [userId, limit]
      );
      return result.rows.reverse();
    } catch (err) {
      console.error('Get history error:', err);
      return [];
    }
  }
}

module.exports = new ChatbotService();
