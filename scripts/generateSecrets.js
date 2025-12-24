#!/usr/bin/env node

/**
 * Generate a strong JWT secret key
 * Dùng: node scripts/generateSecrets.js
 */

const crypto = require('crypto');

console.log('\n🔐 GENERATING SECURE KEYS...\n');

// Generate JWT Secret (256-bit)
const jwtSecret = crypto.randomBytes(32).toString('hex');
console.log('📌 JWT_SECRET (cho .env file):');
console.log(`   JWT_SECRET=${jwtSecret}\n`);

// Generate Database Password (128-bit)
const dbPassword = crypto.randomBytes(16).toString('hex');
console.log('📌 Database Password (tùy chọn):');
console.log(`   DB_PASSWORD=${dbPassword}\n`);

// Generate API Key (256-bit)
const apiKey = crypto.randomBytes(32).toString('base64');
console.log('📌 API Key (nếu cần):');
console.log(`   API_KEY=${apiKey}\n`);

console.log('⚠️  CẬP NHẬT CÁC GIÁ TRỊ NÀY VÀO .env FILE!');
console.log('⚠️  KHÔNG COMMIT ACTUAL .env FILE TỚI GIT!\n');
