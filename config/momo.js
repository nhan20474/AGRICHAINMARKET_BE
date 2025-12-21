const crypto = require('crypto');

const partnerCode = process.env.MOMO_PARTNER_CODE || 'MOMO';
const accessKey = process.env.MOMO_ACCESS_KEY || 'F8BBA842ECF85';
const secretKey = process.env.MOMO_SECRET_KEY || 'K951B6PE1waDMi640xX08PD3vg6EkVlz';
const defaultRedirectUrl = process.env.MOMO_REDIRECT_URL || 'https://momo.vn/return';
const defaultIpnUrl = process.env.MOMO_IPN_URL || 'https://callback.url/notify';
const requestType = 'captureWallet';

function generateMomoRequest({
    amount = "50000",
    orderInfo = "pay with MoMo",
    redirectUrl = defaultRedirectUrl,
    ipnUrl = defaultIpnUrl,
    extraData = ""
} = {}) {
    const requestId = partnerCode + new Date().getTime();
    const orderId = requestId;

    // Tạo rawSignature đúng format MoMo
    const rawSignature =
        "accessKey=" + accessKey +
        "&amount=" + amount +
        "&extraData=" + extraData +
        "&ipnUrl=" + ipnUrl +
        "&orderId=" + orderId +
        "&orderInfo=" + orderInfo +
        "&partnerCode=" + partnerCode +
        "&redirectUrl=" + redirectUrl +
        "&requestId=" + requestId +
        "&requestType=" + requestType;

    // Tạo signature
    const signature = crypto.createHmac('sha256', secretKey)
        .update(rawSignature)
        .digest('hex');

    // Tạo request body (object)
    const requestBody = {
        partnerCode,
        accessKey,
        requestId,
        amount,
        orderId,
        orderInfo,
        redirectUrl,
        ipnUrl,
        extraData,
        requestType,
        signature,
        lang: 'en'
    };

    return { requestBody, rawSignature, signature };
}

module.exports = {
    partnerCode,
    accessKey,
    secretKey,
    redirectUrl: defaultRedirectUrl,
    ipnUrl: defaultIpnUrl,
    requestType,
    endpoint: {
        hostname: 'test-payment.momo.vn',
        port: 443,
        path: '/v2/gateway/api/create'
    },
    generateMomoRequest
};
