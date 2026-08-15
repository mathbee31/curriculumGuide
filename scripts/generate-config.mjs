import fs from 'node:fs';
import path from 'node:path';

// ADMIN_EMAIL은 더 이상 사용하지 않음 (관리자는 DB의 admins 테이블로 식별,
// 앱 내 "최초 관리자 등록" 화면에서 등록함)
const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missing = required.filter(key => !process.env[key]);

if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const config = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SCHOOL_DOMAIN: process.env.SCHOOL_DOMAIN || '',
  ID_SUFFIX: process.env.ID_SUFFIX || 'ckfqhfl',
};

const output = `export const CONFIG = ${JSON.stringify(config, null, 2)};\n`;
const target = path.join(process.cwd(), 'src', 'config.js');

fs.writeFileSync(target, output, 'utf8');
console.log(`Generated ${target}`);
