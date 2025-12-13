require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./config/database');
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const profileRoutes = require('./routes/profileRoutes');
const cartRoutes = require('./routes/cartRoutes');
const orderRoutes = require('./routes/orderRoutes');
const categoriesRouter = require('./routes/categoriesRoutes');
const adminApprovalRouter = require('./routes/admin_approval');
const adminUserRouter = require('./routes/admin_users');
const searchRouter = require('./routes/search');
const uploadRoutes = require('./routes/uploadRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const shippingRoutes = require('./routes/shippingRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const blockchainRoutes = require('./routes/blockchainRoutes');
const chatbotRoutes = require('./routes/chatbotRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const panelRoutes = require('./routes/admin_panels'); 
const discountRoutes = require('./routes/discountRoutes');
const reportsRoutes = require('./routes/reports');
const http = require('http');
const socketio = require('socket.io');

// Khoi tao ung dung express
const app = express();

// Su dung middleware
app.use(cors()); // Cho phep frontend truy cap API
app.use(express.json()); // De server co the doc du lieu JSON tu request
app.use(express.urlencoded({ extended: true }));

// Tao mot route (tuyen duong) de kiem tra
app.get('/', (req, res) => {
  res.send('CHAO MUNG DEN VOI API DO AN CHUYEN NGANH!');
});

// Tao mot route de test ket noi database
app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      message: 'Ket noi database thanh cong!',
      timestamp: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Loi ket noi database' });
  }
});

// Khởi tạo server và io
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: '*'
  }
});

app.set('io', io);

// Lưu kết nối user theo userId
io.userSockets = {}; // Khởi tạo object lưu userId <-> [socketId]

io.on('connection', (socket) => {
  console.log('Socket mới kết nối:', socket.id); // Log mỗi lần có kết nối mới
  socket.on('register', (userId) => {
    io.userSockets[userId] = io.userSockets[userId] || [];
    io.userSockets[userId].push(socket.id);
    console.log(`User ${userId} đã kết nối socket: ${socket.id}`);
  });

  socket.on('disconnect', () => {
    for (const [userId, sockArr] of Object.entries(io.userSockets)) {
      io.userSockets[userId] = sockArr.filter(sid => sid !== socket.id);
      if (io.userSockets[userId].length === 0) {
        delete io.userSockets[userId];
      }
    }
  });
});

// Su dung routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/categories', categoriesRouter);
app.use('/api/admin', adminApprovalRouter);
app.use('/api/admin/users', adminUserRouter);
app.use('/api/search', searchRouter);
app.use('/api/upload', uploadRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/blockchain', blockchainRoutes);
app.use('/api/payments', paymentRoutes);
app.use("/api/panels", panelRoutes);
app.use('/api/discounts', discountRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/notifications', require('./routes/notificationRoutes')(io));


// Cho phép truy cập file tĩnh trong thư mục uploads
app.use('/uploads', express.static('uploads'));

// Route xem tat ca users
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, full_name, email, role, phone_number, address FROM Users');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Loi truy van database' });
  }
});

// NEW: Chi tiet user (/api/users/:id) – thay vi phải gọi /api/profile/:id
app.get('/api/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
    const result = await pool.query(
      'SELECT id, full_name, email, phone_number, address, role FROM Users WHERE id = $1',
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Không tìm thấy user' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi truy vấn user', detail: err.message });
  }
});

// NEW: Chi tiet seller (/api/sellers/:id) + sản phẩm của seller
app.get('/api/sellers/:id', async (req, res) => {
  try {
    const sellerId = parseInt(req.params.id, 10);
    if (isNaN(sellerId)) return res.status(400).json({ error: 'ID không hợp lệ' });

    const sellerRes = await pool.query(
      `SELECT id, full_name, email, phone_number, address, role 
       FROM Users WHERE id = $1 AND role = 'farmer'`,
      [sellerId]
    );
    if (!sellerRes.rows.length) return res.status(404).json({ error: 'Không tìm thấy seller' });

    const productsRes = await pool.query(
      `SELECT id, name, price, quantity, status, image_url, category_id 
       FROM Products WHERE seller_id = $1 ORDER BY created_at DESC`,
      [sellerId]
    );

    res.json({
      seller: sellerRes.rows[0],
      products: productsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi truy vấn seller', detail: err.message });
  }
});

// Route xem tat ca categories
app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Categories');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Loi truy van database' });
  }
});

server.listen(PORT, () => {
  console.log(`Server dang chay tren cong ${PORT}`);
});

// Xu ly loi server
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Cong ${PORT} da duoc su dung. Vui long dong ung dung khac hoac doi PORT.`);
  } else {
    console.error('Loi server:', err);
  }
  process.exit(1);
});

// Xu ly loi uncaught exception
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Xu ly loi unhandled rejection
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  process.exit(1);
});