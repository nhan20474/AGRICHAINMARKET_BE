const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Route dang ky
router.post('/register', authController.register);

// Route dang nhap
router.post('/login', authController.login);

// Route test GET (chi de test)
router.get('/test', (req, res) => {
  res.json({ message: 'Auth routes hoat dong binh thuong!' });
});

// Route forgot password
router.post('/forgot-password', authController.forgotPassword);

// Route reset password
router.post('/reset-password', authController.resetPassword);

// Route change password
router.post('/change-password', authController.changePassword);

module.exports = router;
