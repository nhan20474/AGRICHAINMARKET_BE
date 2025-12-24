# 🔐 SECURITY & ENVIRONMENT SETUP GUIDE

## ✅ CẬP NHẬT ĐÃ THỰC HIỆN

### 1. **JWT Secret Key** ✅
- ✨ **Trước**: Hardcoded `'your_secret_key_here_change_in_production'`
- ✅ **Sau**: Dùng `process.env.JWT_SECRET` từ `.env`
- 📝 **File**: [controllers/authController.js](controllers/authController.js#L7)

### 2. **Database Credentials** ✅
- ✨ **Trước**: Hardcoded password, host, user trong code
- ✅ **Sau**: Dùng environment variables
  ```javascript
  DB_USER=postgres
  DB_HOST=localhost
  DB_PASSWORD=****** (từ .env)
  DB_NAME=do_an_chuyen_nganh
  DB_PORT=5432
  ```
- 📝 **File**: [config/database.js](config/database.js)

### 3. **Blockchain Private Key** ✅
- ✨ **Trước**: Stored in `blockchain/.env`
- ✅ **Sau**: Read từ root `.env` file (tập trung 1 nơi)
- 📝 **File**: [blockchain/hardhat.config.js](blockchain/hardhat.config.js) (đã dùng đúng)

### 4. **Environment Template** ✅
- ✅ Created `.env.example` - template để guide developers
- ✅ Created `blockchain/.env.example` - blockchain config guide

---

## 🚀 HƯỚNG DẪN SỬ DỤNG

### Step 1: Tạo JWT Secret mạnh
```bash
# Chạy script này để generate secret key
node scripts/generateSecrets.js

# Hoặc manual:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 2: Setup .env file
```bash
# Copy template
cp .env.example .env

# Edit .env và điền thông tin thực tế:
# - DB_PASSWORD: mật khẩu PostgreSQL của bạn
# - JWT_SECRET: copy từ kết quả generateSecrets.js
# - PRIVATE_KEY: wallet private key (blockchain)
# - API Keys: Gemini, Email, MoMo
```

### Step 3: Kiểm tra .gitignore
```bash
# Xác nhận .env được thêm vào .gitignore
cat .gitignore | grep "\.env"
```

---

## 📋 ENVIRONMENT VARIABLES

### Database
```env
DB_USER=postgres
DB_HOST=localhost
DB_NAME=do_an_chuyen_nganh
DB_PASSWORD=your_password
DB_PORT=5432
```

### JWT
```env
JWT_SECRET=your_256_bit_hex_key_here
JWT_EXPIRE=24h
```

### Blockchain (Polygon Amoy)
```env
AMOY_RPC=https://rpc-amoy.polygon.technology
PRIVATE_KEY=0xyour_wallet_private_key
CONTRACT_ADDRESS=0xyour_contract_address
```

### External APIs
```env
# Google Gemini (Chatbot)
GEMINI_API_KEY=your_key_here

# Gmail (Email sending)
EMAIL_USER=your_gmail@gmail.com
EMAIL_PASSWORD=your_app_password

# MoMo Payment
MOMO_PARTNER_CODE=MOMO
MOMO_ACCESS_KEY=...
MOMO_SECRET_KEY=...
MOMO_REDIRECT_URL=...
MOMO_IPN_URL=...
```

---

## 🛡️ BEST PRACTICES

### ✅ DO's
- ✅ Lưu `.env` vào `.gitignore`
- ✅ Dùng environment variables cho tất cả credentials
- ✅ Generate strong JWT secret (256-bit minimum)
- ✅ Rotate secrets hàng tháng
- ✅ Dùng `.env.example` để guide developers
- ✅ Validate .env variables khi app start

### ❌ DON'Ts
- ❌ Commit `.env` file to git
- ❌ Hardcode passwords trong source code
- ❌ Dùng mặc định/dummy values ở production
- ❌ Chia sẻ `.env` qua email/chat
- ❌ Log sensitive data (passwords, tokens)

---

## 🔍 VERIFICATION

### Kiểm tra JWT Secret được load đúng
```bash
# Start server và check logs
npm start

# Hoặc test direct:
node -e "require('dotenv').config(); console.log(process.env.JWT_SECRET)"
```

### Kiểm tra Database Connection
```bash
# Visit: http://localhost:3000/test-db
# Response nên có: "Ket noi database thanh cong!"
```

---

## 📝 NOTES FOR PRODUCTION

Trước khi deploy lên production:

1. **Tạo JWT Secret mạnh**
   ```bash
   node scripts/generateSecrets.js
   ```

2. **Cập nhật Database Credentials** (nếu có DB riêng)
   ```env
   DB_USER=prod_user
   DB_PASSWORD=very_strong_password_here
   DB_HOST=your_prod_db_host
   ```

3. **Cấu hình CORS**
   ```javascript
   // Update server.js CORS config
   app.use(cors({
     origin: 'https://your-frontend-domain.com',
     credentials: true
   }));
   ```

4. **Validate Environment Setup**
   ```bash
   # Check tất cả .env vars được set
   node -e "require('dotenv').config(); \
   console.log('JWT_SECRET:', !!process.env.JWT_SECRET); \
   console.log('DB_PASSWORD:', !!process.env.DB_PASSWORD); \
   console.log('PRIVATE_KEY:', !!process.env.PRIVATE_KEY);"
   ```

---

## 📚 REFERENCES

- [Node.js dotenv Documentation](https://www.npmjs.com/package/dotenv)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8949)
- [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

---

**Last Updated**: December 24, 2025
**Status**: ✅ All credentials moved to environment variables
