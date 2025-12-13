-- =================================================================================
-- XÓA DỮ LIỆU CŨ (NẾU CÓ)
-- =================================================================================
TRUNCATE TABLE Reviews, Provenance, OrderItems, Orders, Products, Categories, Users RESTART IDENTITY CASCADE;

-- =================================================================================
-- THÊM DỮ LIỆU MẪU
-- Lưu ý: Chạy script hashPassword.js để lấy password hash và thay vào dưới đây
-- Password gốc cho tất cả tài khoản: 123456
-- =================================================================================

-- 1. Thêm Users (password hash cho "123456" là: $2b$10$wqv1wQwQwQwQwQwQwQwQwOQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQw')
INSERT INTO Users (full_name, email, password_hash, phone_number, address, role) VALUES
('Nguyen Van Admin', 'admin@agrichain.com', '$2b$10$wqv1wQwQwQwQwQwQwQwQwOQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQw', '0901234567', 'Ha Noi', 'admin'),
('Tran Thi Lan', 'farmer1@example.com', '$2b$10$wqv1wQwQwQwQwQwQwQwQwOQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQw', '0912345678', 'Dong Thap', 'farmer'),
('Le Van Binh', 'farmer2@example.com', '$2b$10$wqv1wQwQwQwQwQwQwQwQwOQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQw', '0923456789', 'An Giang', 'farmer'),
('Pham Thi Hoa', 'consumer1@example.com', '$2b$10$wqv1wQwQwQwQwQwQwQwQwOQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQw', '0934567890', 'TP Ho Chi Minh', 'consumer'),
('Hoang Van Nam', 'consumer2@example.com', '$2b$10$wqv1wQwQwQwQwQwQwQwQwOQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQwQw', '0945678901', 'Ha Noi', 'consumer');

-- 2. Thêm Categories
INSERT INTO Categories (name, description) VALUES
('Rau củ quả', 'Các loại rau, củ, quả tươi sạch'),
('Trái cây', 'Trái cây tươi ngon từ vườn'),
('Nông sản khô', 'Gạo, ngô, đậu và các loại hạt khô'),
('Gia vị', 'Gia vị tự nhiên từ nông trại'),
('Thực phẩm chế biến', 'Các sản phẩm chế biến từ nông sản');

-- 3. Thêm Products
INSERT INTO Products (name, description, price, quantity, image_url, status, seller_id, category_id) VALUES
('Khoai tây Đà Lạt', 'Khoai tây tươi ngon, trồng tại Đà Lạt', 22000, 50, '/images/khoai-tay.jpg', 'available', 16, 1),
('Rau cải xanh hữu cơ', 'Rau cải xanh trồng theo phương pháp hữu cơ, không thuốc trừ sâu', 15000, 100, '/images/rau-cai-xanh.jpg', 'available', 16, 1),
('Cà chua bi', 'Cà chua bi ngọt, giàu vitamin C', 25000, 80, '/images/ca-chua-bi.jpg', 'available', 16, 1),
('Gạo ST25', 'Gạo ST25 đặc sản, thơm ngon', 35000, 500, '/images/gao-st25.jpg', 'available', 3, 3),
('Xoài cát Hòa Lộc', 'Xoài cát Hòa Lộc chính gốc Đồng Tháp', 60000, 200, '/images/xoai-hoa-loc.jpg', 'available', 2, 2),
('Chanh dây', 'Chanh dây tươi, nhiều nước', 30000, 150, '/images/chanh-day.jpg', 'available', 3, 2),
('Ớt hiểm', 'Ớt hiểm cay nồng, tự nhiên', 40000, 50, '/images/ot-hiem.jpg', 'available', 2, 4),
('Mật ong rừng', 'Mật ong rừng nguyên chất 100%', 150000, 30, '/images/mat-ong.jpg', 'pending_approval', 3, 5),
('Cà rốt Đà Lạt', 'Cà rốt Đà Lạt tươi ngon', 20000, 120, '/images/ca-rot.jpg', 'available', 2, 1),
('Dưa hấu không hạt', 'Dưa hấu ngọt mát, không hạt', 18000, 90, '/images/dua-hau.jpg', 'available', 3, 2),
('Nấm hương khô', 'Nấm hương Đà Lạt phơi khô', 120000, 40, '/images/nam-huong.jpg', 'available', 2, 5);

-- 6. Thêm Provenance
INSERT INTO Provenance (product_id, qr_code_hash, blockchain_transaction_id, production_steps) VALUES
(1, 'QR123ABC456DEF', '0x1234567890abcdef1234567890abcdef12345678', '{"steps": [{"date": "2024-01-15", "action": "Gieo hạt", "location": "Dong Thap"}, {"date": "2024-02-20", "action": "Thu hoạch", "location": "Dong Thap"}]}'),
(3, 'QR345GHI678JKL', '0x9876543210fedcba9876543210fedcba98765432', '{"steps": [{"date": "2023-11-01", "action": "Gieo mạ", "location": "An Giang"}, {"date": "2024-02-28", "action": "Thu hoạch", "location": "An Giang"}, {"date": "2024-03-05", "action": "Sấy khô", "location": "An Giang"}]}'),
(4, 'QR789MNO012PQR', '0xabcdef1234567890abcdef1234567890abcdef12', '{"steps": [{"date": "2024-01-01", "action": "Ra hoa", "location": "Dong Thap"}, {"date": "2024-03-15", "action": "Thu hoạch", "location": "Dong Thap"}]}'),
(7, 'QR567STU890VWX', '0xfedcba0987654321fedcba0987654321fedcba09', '{"steps": [{"date": "2024-01-10", "action": "Thu hoạch mật", "location": "Rừng U Minh"}, {"date": "2024-01-12", "action": "Lọc và đóng chai", "location": "An Giang"}]}');

-- (Sau khi đã INSERT Products / Orders nếu có) thêm seed Reviews mẫu
INSERT INTO Reviews (order_id, product_id, user_id, rating, comment, created_at)
VALUES
(1, 1, 4, 5, 'Rất hài lòng về chất lượng khoai tây', NOW() - INTERVAL '2 days'),
(1, 3, 4, 4, 'Gạo ngon nhưng giao hơi chậm', NOW() - INTERVAL '1 day'),
(2, 4, 5, 5, 'Xoài rất thơm và ngọt', NOW() - INTERVAL '2 hours');

-- =================================================================================
-- KIỂM TRA DỮ LIỆU
-- =================================================================================
SELECT 'Users' as table_name, COUNT(*) as total FROM Users
UNION ALL
SELECT 'Categories', COUNT(*) FROM Categories
UNION ALL
SELECT 'Products', COUNT(*) FROM Products
UNION ALL
SELECT 'Orders', COUNT(*) FROM Orders
UNION ALL
SELECT 'OrderItems', COUNT(*) FROM OrderItems
UNION ALL
SELECT 'Provenance', COUNT(*) FROM Provenance;
