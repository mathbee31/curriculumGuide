import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CONFIG } from './config.js';

const url = CONFIG.SUPABASE_URL;
const key = CONFIG.SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL 또는 SUPABASE_ANON_KEY가 설정되지 않았습니다.');
}

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
