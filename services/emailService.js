const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

exports.sendResetPasswordEmail = async (email, resetToken) => {
    const resetLink = `http://localhost:5173/reset-password?token=${resetToken}`;
    
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: '🔐 Đặt lại mật khẩu - AgriChain',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #28a745;">Đặt lại mật khẩu</h2>
                <p>Bạn đã yêu cầu đặt lại mật khẩu cho tài khoản AgriChain.</p>
                <div style="text-align: center; margin: 30px 0;">
                    <a href="${resetLink}" 
                       style="background: #28a745; color: white; padding: 12px 30px; 
                              text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
                        Đặt lại mật khẩu
                    </a>
                </div>
                <p>Hoặc copy link: ${resetLink}</p>
                <p><strong>⏰ Link có hiệu lực trong 1 giờ.</strong></p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('✅ Email reset password đã gửi:', email);
        return true;
    } catch (error) {
        console.error('❌ Lỗi gửi email:', error);
        throw new Error('Không thể gửi email');
    }
};

exports.sendPasswordChangeConfirmation = async (email, userName) => {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: '✅ Mật khẩu đã được thay đổi - AgriChain',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #28a745;">Mật khẩu đã được cập nhật</h2>
                <p>Xin chào <strong>${userName}</strong>,</p>
                <p>Mật khẩu tài khoản AgriChain của bạn đã được thay đổi thành công.</p>
                <p>⏰ Thời gian: <strong>${new Date().toLocaleString('vi-VN')}</strong></p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('✅ Email xác nhận đã gửi:', email);
    } catch (error) {
        console.error('❌ Lỗi gửi email:', error);
    }
};
