module.exports = {
    partnerCode: process.env.MOMO_PARTNER_CODE || 'MOMO',
    accessKey: process.env.MOMO_ACCESS_KEY || 'F8BBA842ECF85',
    secretKey: process.env.MOMO_SECRET_KEY || 'K951B6PE1waDMi640xX08PD3vg6EkVlz',
    redirectUrl: process.env.MOMO_REDIRECT_URL || 'http://localhost:5173/payment/success',
    ipnUrl: process.env.MOMO_IPN_URL || 'http://localhost:3000/api/payments/momo/callback', // ✅ SỬA LẠI
    requestType: 'captureWallet',
    endpoint: {
        hostname: 'test-payment.momo.vn',
        port: 443,
        path: '/v2/gateway/api/create'
    }
};
