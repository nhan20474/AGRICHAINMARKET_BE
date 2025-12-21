const url = require('url');

module.exports = {
    vnp_TmnCode: process.env.VNP_TMN_CODE || 'BCDEC6H8',
    vnp_HashSecret: process.env.VNP_HASH_SECRET || 'BYNQT6V4BAMU9WPO2ECN6PIX4KT69JR6',
    vnp_Url: process.env.VNP_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    vnp_ReturnUrl: process.env.VNP_RETURN_URL || 'http://localhost:3000/api/payments/vnpay/return',
    vnp_IpAddr: process.env.VNP_IP_ADDR || '127.0.0.1',
    vnp_Version: process.env.VNP_VERSION || '2.1.0',
    vnp_Command: process.env.VNP_COMMAND || 'pay',
    vnp_CurrCode: process.env.VNP_CURRENCY || 'VND',
    merchantAdminUrl: process.env.VNP_MERCHANT_ADMIN_URL || 'https://sandbox.vnpayment.vn/merchantv2/',
    sitTestingUrl: process.env.VNP_SIT_TEST_URL || 'https://sandbox.vnpayment.vn/vnpaygw-sit-testing/user/login'
};
