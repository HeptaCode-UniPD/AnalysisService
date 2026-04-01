import { createSourceBundle } from './dist/lambdas/utils/smart-bundler';
import path from 'path';

async function test() {
  try {
    const res = await createSourceBundle('.');
    console.log('Bundle length:', res.length);
  } catch (err) {
    console.error('Bundle failed:', err);
  }
}
test();
