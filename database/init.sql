-- =============================================
-- 1. XÓA BẢNG CŨ (DROP TABLES) - Thứ tự quan trọng
-- =============================================
DROP TABLE IF EXISTS ChatMessages CASCADE; -- Xóa bảng Chat trước
DROP TABLE IF EXISTS Reviews CASCADE;
DROP TABLE IF EXISTS ShippingInfo CASCADE;
DROP TABLE IF EXISTS Notifications CASCADE;
DROP TABLE IF EXISTS FarmerApplications CASCADE;
DROP TABLE IF EXISTS Provenance CASCADE;
DROP TABLE IF EXISTS CartItems CASCADE;
DROP TABLE IF EXISTS OrderItems CASCADE;
DROP TABLE IF EXISTS Payments CASCADE;
DROP TABLE IF EXISTS Orders CASCADE;
DROP TABLE IF EXISTS Products CASCADE;
DROP TABLE IF EXISTS Categories CASCADE;
DROP TABLE IF EXISTS Users CASCADE;
DROP TABLE IF EXISTS Panels CASCADE;
DROP TABLE IF EXISTS Discounts CASCADE;
DROP TABLE IF EXISTS Reports CASCADE;

-- =============================================
-- 2. TẠO BẢNG (SCHEMA)
-- =============================================

-- 1. Users
CREATE TABLE Users (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    phone_number VARCHAR(20),
    address TEXT,
    role VARCHAR(50) NOT NULL CHECK (role IN ('farmer', 'consumer', 'admin')),
    is_locked BOOLEAN DEFAULT FALSE,
    reset_token VARCHAR(255),
    reset_token_expires TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2. Categories
CREATE TABLE Categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT
);

-- 3. Products
CREATE TABLE Products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(12, 2) NOT NULL,
    sale_price DECIMAL(12, 2),
    quantity INT NOT NULL,
    unit VARCHAR(50) NOT NULL DEFAULT 'kg',
    image_url VARCHAR(255),
    extra_images JSONB DEFAULT '[]',
    status VARCHAR(50) NOT NULL CHECK (status IN ('available', 'sold_out', 'pending_approval', 'rejected', 'out_of_stock', 'deleted')), -- THÊM 'deleted'
    seller_id INT NOT NULL,
    category_id INT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (seller_id) REFERENCES Users(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES Categories(id) ON DELETE SET NULL
);

-- 4. Orders
CREATE TABLE Orders (
    id SERIAL PRIMARY KEY,
    buyer_id INT NOT NULL,
    seller_id INT NOT NULL, -- THÊM: Mỗi đơn hàng chỉ chứa sản phẩm của 1 farmer
    total_amount DECIMAL(12, 2) NOT NULL,
    discount_amount DECIMAL(12, 2) DEFAULT 0, 
    discount_code VARCHAR(50),
    shipping_address TEXT NOT NULL,
    status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'received', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (buyer_id) REFERENCES Users(id) ON DELETE CASCADE,
    FOREIGN KEY (seller_id) REFERENCES Users(id) ON DELETE CASCADE -- THÊM: Khóa ngoại tới seller
);

-- 4b. Payments (Bảng thanh toán)
CREATE TABLE Payments (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL UNIQUE,
    payment_method VARCHAR(50) NOT NULL CHECK (payment_method IN ('cod', 'bank_transfer', 'momo', 'vnpay', 'zalopay')),
    payment_status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
    amount DECIMAL(12, 2) NOT NULL,
    transaction_id VARCHAR(255) UNIQUE,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES Orders(id) ON DELETE CASCADE
);

-- 5. OrderItems
CREATE TABLE OrderItems (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT, -- SỬA: Cho phép NULL khi sản phẩm bị xóa
    quantity INT NOT NULL,
    price_per_item DECIMAL(12, 2) NOT NULL,
    product_name VARCHAR(255), -- THÊM: Lưu tên sản phẩm để hiển thị sau khi xóa
    product_image_url VARCHAR(255), -- THÊM: Lưu ảnh để hiển thị
    FOREIGN KEY (order_id) REFERENCES Orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES Products(id) ON DELETE SET NULL -- SỬA: SET NULL thay vì CASCADE
);

-- 6. CartItems
CREATE TABLE CartItems (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    added_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES Products(id) ON DELETE CASCADE
);

-- 7. Provenance (Truy xuất nguồn gốc)
CREATE TABLE Provenance (
    id SERIAL PRIMARY KEY,
    product_id INT, -- SỬA: Cho phép NULL
    qr_code_hash VARCHAR(255) UNIQUE,
    blockchain_transaction_id VARCHAR(255) UNIQUE,
    production_steps JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES Products(id) ON DELETE SET NULL -- SỬA: SET NULL
);

-- Đảm bảo product_id là duy nhất (phục vụ ON CONFLICT khi ghi log blockchain)
CREATE UNIQUE INDEX IF NOT EXISTS idx_provenance_product_id ON Provenance(product_id);

-- 8. FarmerApplications
CREATE TABLE FarmerApplications (
    id SERIAL PRIMARY KEY,
    user_id INT UNIQUE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending' 
        CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
    business_license_url VARCHAR(255),
    farm_address TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
);

-- Đảm bảo user_id là duy nhất (phòng trường hợp migrate DB cũ không có unique)
CREATE UNIQUE INDEX IF NOT EXISTS idx_farmer_applications_user_id ON FarmerApplications(user_id);

-- 9. Notifications
CREATE TABLE Notifications (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL,
    sender_id INT,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255),
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    product_id INT,
    order_id INT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES Users(id) ON DELETE SET NULL,
    FOREIGN KEY (product_id) REFERENCES Products(id) ON DELETE CASCADE,
    FOREIGN KEY (order_id) REFERENCES Orders(id) ON DELETE CASCADE
);

-- 10. ShippingInfo
CREATE TABLE ShippingInfo (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT, -- SỬA: Cho phép NULL
    shipping_company VARCHAR(255),
    tracking_number VARCHAR(255),
    shipping_status VARCHAR(50) NOT NULL 
        CHECK (shipping_status IN ('pending', 'processing', 'shipped', 'delivered', 'received', 'cancelled')),
    shipped_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES Orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES Products(id) ON DELETE SET NULL, -- SỬA: SET NULL
    UNIQUE(order_id, product_id)
);

-- 11. Reviews
CREATE TABLE Reviews (
    id SERIAL PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT, -- SỬA: Cho phép NULL
    user_id INT NOT NULL,
    rating INT CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    product_name VARCHAR(255), -- THÊM: Lưu tên sản phẩm
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    FOREIGN KEY (order_id) REFERENCES Orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES Products(id) ON DELETE SET NULL, -- SỬA: SET NULL
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
    CONSTRAINT unique_review_per_purchase UNIQUE (order_id, product_id, user_id)
);

-- 12. ChatMessages (Chatbot/AI)
CREATE TABLE ChatMessages (
    id SERIAL PRIMARY KEY,
    user_id INT, -- Cho phép NULL nếu khách vãng lai chat
    session_id VARCHAR(100), -- Thêm session_id để track khách vãng lai
    message TEXT NOT NULL,
    response TEXT NOT NULL,
    context JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE SET NULL
);

-- 13. Panels (Quản lý nội dung trang)
CREATE TABLE Panels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    page VARCHAR(100) NOT NULL,
    content JSONB DEFAULT '{}',
    images JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 14. Discounts (Mã giảm giá)
CREATE TABLE Discounts (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    discount_percent INT CHECK (discount_percent BETWEEN 1 AND 100),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    usage_limit INT DEFAULT 1,
    used_count INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 15. Reports (Báo cáo thống kê)
DROP TABLE IF EXISTS Reports CASCADE;

CREATE TABLE Reports (
    id SERIAL PRIMARY KEY,

    report_date DATE NOT NULL,

    seller_id INT NULL,      -- NULL = Admin
    product_id INT NULL,     -- mở rộng sau

    total_orders INT NOT NULL DEFAULT 0,
    total_quantity INT NOT NULL DEFAULT 0,
    total_revenue DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_discount DECIMAL(12,2) NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_reports_seller
        FOREIGN KEY (seller_id)
        REFERENCES Users(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_reports_product
        FOREIGN KEY (product_id)
        REFERENCES Products(id)
        ON DELETE SET NULL,

    CONSTRAINT chk_reports_orders CHECK (total_orders >= 0),
    CONSTRAINT chk_reports_quantity CHECK (total_quantity >= 0),
    CONSTRAINT chk_reports_revenue CHECK (total_revenue >= 0),
    CONSTRAINT chk_reports_discount CHECK (total_discount >= 0)
);

-- Seller: 1 ngày – 1 seller – 1 dòng
CREATE UNIQUE INDEX unique_daily_seller_report
ON Reports (report_date, seller_id)
WHERE seller_id IS NOT NULL;

-- Admin: 1 ngày – 1 dòng
CREATE UNIQUE INDEX unique_daily_admin_report
ON Reports (report_date)
WHERE seller_id IS NULL AND product_id IS NULL;


-- Index để query nhanh theo ngày và seller
CREATE INDEX idx_reports_date ON Reports (report_date);
CREATE INDEX idx_reports_seller ON Reports (seller_id);
CREATE INDEX idx_reports_product ON Reports (product_id);
CREATE INDEX idx_reports_date_seller ON Reports (report_date, seller_id);

CREATE OR REPLACE FUNCTION update_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reports_updated_at
BEFORE UPDATE ON Reports
FOR EACH ROW
EXECUTE FUNCTION update_reports_updated_at();


-- Indexes
CREATE INDEX idx_reviews_product ON Reviews(product_id);
CREATE INDEX idx_reviews_user ON Reviews(user_id);
CREATE INDEX idx_chat_user ON ChatMessages(user_id);
CREATE INDEX idx_chat_created ON ChatMessages(created_at DESC);
CREATE INDEX idx_payments_order ON Payments(order_id);
CREATE INDEX idx_payments_status ON Payments(payment_status);

-- =============================================
-- 3. INSERT DATA (DỮ LIỆU MẪU)
-- =============================================

-- USERS
INSERT INTO Users (full_name, email, password_hash, phone_number, address, role, is_locked) VALUES
('Nguyen Van Admin', 'admin@agrichain.com', '$2b$10$sggTYF3ZIgqLJI5jY4eadeDxqAN8n3iq6t4k1n81mxioPOoAruYGy', '0901234567', 'VP Ha Noi', 'admin', FALSE),
('Tran Thi Lan (Farmer)', 'farmer1@example.com', '$2b$10$sggTYF3ZIgqLJI5jY4eadeDxqAN8n3iq6t4k1n81mxioPOoAruYGy', '0912345678', 'Dong Thap', 'farmer', FALSE),
('Le Van Binh (Farmer)', 'farmer2@example.com', '$2b$10$sggTYF3ZIgqLJI5jY4eadeDxqAN8n3iq6t4k1n81mxioPOoAruYGy', '0923456789', 'An Giang', 'farmer', FALSE),
('Pham Thi Hoa (Buyer)', 'consumer1@example.com', '$2b$10$sggTYF3ZIgqLJI5jY4eadeDxqAN8n3iq6t4k1n81mxioPOoAruYGy', '0934567890', 'TP HCM', 'consumer', FALSE),
('Hoang Van Nam (Buyer)', 'consumer2@example.com', '$2b$10$sggTYF3ZIgqLJI5jY4eadeDxqAN8n3iq6t4k1n81mxioPOoAruYGy', '0945678901', 'Ha Noi', 'consumer', FALSE),
('Nguyen Van Moi (Pending)', 'newfarmer@example.com', '$2b$10$sggTYF3ZIgqLJI5jY4eadeDxqAN8n3iq6t4k1n81mxioPOoAruYGy', '0988888888', 'Long An', 'consumer', FALSE);

-- CATEGORIES
INSERT INTO Categories (name, description) VALUES
('Rau củ quả', 'Rau sạch, củ quả tươi'),
('Trái cây', 'Trái cây nhiệt đới'),
('Nông sản khô', 'Gạo, đậu, hạt tiêu'),
('Gia vị', 'Hành, tỏi, ớt, gia vị khô'),
('Thực phẩm chế biến', 'Đồ sấy khô, mứt');

-- FARMER APPLICATIONS
INSERT INTO FarmerApplications (user_id, status, farm_address, business_license_url, notes) VALUES
(2, 'approved', 'Cao Lãnh, Đồng Tháp', '/license/lan.pdf', 'Đã xác thực'),
(3, 'approved', 'Châu Thành, An Giang', '/license/binh.pdf', 'Đạt chuẩn VietGAP'),
(6, 'pending', 'Đức Hòa, Long An', '/license/moi.jpg', 'Chờ xét duyệt');

-- PRODUCTS
INSERT INTO Products (name, description, price, quantity, unit, image_url, status, seller_id, category_id) VALUES
('Khoai tây Đà Lạt', 'Khoai tây tươi ngon', 22000, 50, 'kg', 'https://via.placeholder.com/150', 'available', 2, 1),
('Rau cải xanh', 'Trồng hữu cơ', 15000, 100, 'kg', 'https://via.placeholder.com/150', 'available', 2, 1),
('Gạo ST25', 'Gạo ngon nhất thế giới', 35000, 500, 'kg', 'https://via.placeholder.com/150', 'available', 3, 3),
('Xoài cát Hòa Lộc', 'Xoài chín cây', 60000, 200, 'kg', 'https://via.placeholder.com/150', 'available', 3, 2),
('Sầu riêng Ri6', 'Cơm vàng hạt lép', 120000, 50, 'trái', 'https://via.placeholder.com/150', 'pending_approval', 2, 2),
('Hạt tiêu Phú Quốc', 'Cay nồng thơm', 200000, 5, 'kg', 'https://via.placeholder.com/150', 'available', 3, 4),
('Chuối sấy dẻo', 'Không nhãn mác', 10000, 20, 'gói', 'https://via.placeholder.com/150', 'rejected', 2, 5),
('Bắp Mỹ', 'Ngọt, hạt đều', 5000, 0, 'trái', 'https://via.placeholder.com/150', 'out_of_stock', 3, 1);

-- ORDERS
-- Đơn 1
INSERT INTO Orders (buyer_id, seller_id, total_amount, shipping_address, status, created_at)
VALUES (4, 2, 44000, 'Q1, TP HCM', 'delivered', NOW() - INTERVAL '5 days');

INSERT INTO OrderItems (order_id, product_id, quantity, price_per_item, product_name, product_image_url)
VALUES (1, 1, 2, 22000, 'Khoai tây Đà Lạt', 'https://via.placeholder.com/150');

-- Đơn 2
INSERT INTO Orders (buyer_id, seller_id, total_amount, shipping_address, status, created_at)
VALUES (4, 3, 35000, 'Q1, TP HCM', 'delivered', NOW() - INTERVAL '5 days');

INSERT INTO OrderItems (order_id, product_id, quantity, price_per_item, product_name, product_image_url)
VALUES (2, 3, 1, 35000, 'Gạo ST25', 'https://via.placeholder.com/150');

-- Đơn 3
INSERT INTO Orders (buyer_id, seller_id, total_amount, shipping_address, status, created_at)
VALUES (5, 3, 120000, 'Ba Dinh, Ha Noi', 'processing', NOW() - INTERVAL '1 hour');

INSERT INTO OrderItems (order_id, product_id, quantity, price_per_item, product_name, product_image_url)
VALUES (3, 4, 2, 60000, 'Xoài cát Hòa Lộc', 'https://via.placeholder.com/150');


-- NOTIFICATIONS
INSERT INTO Notifications (user_id, sender_id, type, title, message, is_read, created_at) 
VALUES (1, NULL, 'system', 'Bảo trì hệ thống', 'Hệ thống bảo trì lúc 00:00.', TRUE, NOW() - INTERVAL '2 days');

INSERT INTO Notifications (user_id, sender_id, type, title, message, is_read, product_id, created_at)
VALUES (2, 1, 'inventory_warning', '⚠️ Yêu cầu bổ sung hàng', 'Sản phẩm Khoai tây sắp hết.', FALSE, 1, NOW() - INTERVAL '1 hour');

-- PROVENANCE
INSERT INTO Provenance (product_id, qr_code_hash, blockchain_transaction_id, production_steps)
VALUES (3, 'QR_GAO_ST25', '0xabc...', '{"steps": [{"date": "2024-01-01", "action": "Gieo mạ"}]}');

-- REVIEWS
INSERT INTO Reviews (order_id, product_id, user_id, rating, comment, created_at)
VALUES 
(1, 1, 4, 5, 'Khoai tây rất tươi, giao nhanh!', NOW() - INTERVAL '1 day'),
(1, 3, 4, 4, 'Gạo thơm ngon, nhưng ship hơi lâu.', NOW() - INTERVAL '1 day');

-- SHIPPING INFO (Thêm cho các đơn hàng cũ)
INSERT INTO ShippingInfo (order_id, product_id, shipping_company, tracking_number, shipping_status, shipped_at, delivered_at)
VALUES 
(1, 1, 'GiaoHangNhanh', 'GHN123', 'delivered', NOW() - INTERVAL '4 days', NOW() - INTERVAL '2 days'),
(2, 3, 'GiaoHangNhanh', 'GHN124', 'delivered', NOW() - INTERVAL '4 days', NOW() - INTERVAL '2 days'),
(3, 4, 'ViettelPost', 'VTP456', 'processing', NOW() - INTERVAL '12 hours', NULL);

-- PAYMENTS (Thêm cho các đơn hàng cũ)
INSERT INTO Payments (order_id, payment_method, payment_status, amount, transaction_id, paid_at, created_at)
VALUES 
(1, 'cod', 'paid', 44000, 'COD-1-' || extract(epoch from NOW()), NOW() - INTERVAL '2 days', NOW() - INTERVAL '5 days'),
(2, 'cod', 'paid', 35000, 'COD-2-' || extract(epoch from NOW()), NOW() - INTERVAL '2 days', NOW() - INTERVAL '5 days'),
(3, 'momo', 'paid', 120000, 'MOMO-3-' || extract(epoch from NOW()), NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour');

-- A. DỮ LIỆU CHO ADMIN (Toàn sàn - seller_id IS NULL)
INSERT INTO Reports (report_date, seller_id, total_orders, total_quantity, total_revenue, total_discount) VALUES
('2025-12-01', NULL, 50, 150, 8500000, 200000),
('2025-12-02', NULL, 65, 180, 10200000, 350000),
('2025-12-03', NULL, 40, 120, 6000000, 100000),
('2025-12-04', NULL, 90, 250, 15000000, 800000),
('2025-12-05', NULL, 120, 350, 22000000, 1500000); -- Ngày hôm nay cao nhất

-- B. DỮ LIỆU CHO FARMER 2 (Tran Thi Lan)
INSERT INTO Reports (report_date, seller_id, total_orders, total_quantity, total_revenue, total_discount) VALUES
('2025-12-01', 2, 20, 60, 3000000, 50000),
('2025-12-02', 2, 25, 70, 3800000, 100000),
('2025-12-03', 2, 15, 40, 2200000, 0),
('2025-12-04', 2, 40, 100, 6000000, 300000),
('2025-12-05', 2, 60, 150, 9500000, 500000);

-- C. DỮ LIỆU CHO FARMER 3 (Le Van Binh)
INSERT INTO Reports (report_date, seller_id, total_orders, total_quantity, total_revenue, total_discount) VALUES
('2025-12-01', 3, 30, 90, 5500000, 150000),
('2025-12-02', 3, 40, 110, 6400000, 250000),
('2025-12-03', 3, 25, 80, 3800000, 100000),
('2025-12-04', 3, 50, 150, 9000000, 500000),
('2025-12-05', 3, 60, 200, 12500000, 1000000);